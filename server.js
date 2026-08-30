require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { mountAnalyticsRelay } = require('./analytics-relay');
const { createDashboardAuth } = require('./dashboard-auth');
const { scheduleAlignedTask } = require('./aligned-scheduler');
const { createBrowserSaveCollector } = require('./browser-save-collector');
const { createCollectionDayPlan, resetDailyGrowth } = require('./collection-day');
const {
    getDailyTrends,
    getHourlyTrends,
    updateDailyTrendSnapshot
} = require('./plugin-trends');
const {
    addMandatoryPluginsToWatchlist,
    buildWatchlist,
    collectSaveCounts,
    extractSaveCount,
    loadSaveCache,
    loadWatchlist,
    REALTIME_SAVE_CONTENT_IDS,
    storeSaveCache,
    storeWatchlist
} = require('./save-tracker');
const app = express();
app.set('trust proxy', 1);
const port = Number.parseInt(process.env.SERVER_PORT || '1086', 10);
const host = process.env.SERVER_HOST || '127.0.0.1';
const DATA_DIRECTORY = path.join(__dirname, 'data');
const DAILY_TRENDS_PATH = path.join(__dirname, 'state', 'plugin-daily-trends.json');
const PUBLIC_DIRECTORY = path.join(__dirname, 'public');
const PRODUCT_BASE_PATH = '/product/plugin-data';
const FIXED_PLUGINS = [
    {
        contentId: '1370606842652257742',
        searchQuery: 'i Charts Generate'
    },
    {
        contentId: '1387823712562916211',
        searchQuery: 'i3D'
    },
    {
        contentId: '1414925802794094447',
        searchQuery: 'inima animation'
    },
    {
        contentId: '1473659572195493091',
        searchQuery: 'i Print CMYK'
    },
    {
        contentId: '731451122947612104',
        searchQuery: 'Charts'
    },
    {
        contentId: '1404821057322599271',
        searchQuery: 'UCharts'
    },
    {
        contentId: '1249759048471403961',
        searchQuery: 'Fast Isometric'
    },
    {
        contentId: '988173868842375596',
        searchQuery: 'Aninix'
    },
    {
        contentId: '961270034818256057',
        searchQuery: 'Jitter Animation'
    },
    {
        contentId: '874441781480244375',
        searchQuery: 'Print for Figma CMYK'
    }
];
const browserSaveCollector = createBrowserSaveCollector({ extractSaveCount });
const REALTIME_SAVE_BATCH_SIZE = 3;
const REALTIME_SAVE_DELAY_MS = 8000;
const REALTIME_SAVE_DELAY_JITTER_MS = 4000;

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function prefetchRealtimeSaveCounts(currentTime) {
    const allContentIds = [...REALTIME_SAVE_CONTENT_IDS];
    const batchSize = Math.min(REALTIME_SAVE_BATCH_SIZE, allContentIds.length);
    const batchNumber = Math.floor(currentTime.getTime() / 1800000);
    const offset = (batchNumber * batchSize) % allContentIds.length;
    const orderedContentIds = [
        ...allContentIds.slice(offset),
        ...allContentIds.slice(0, offset)
    ];
    const selectedContentIds = orderedContentIds.slice(0, batchSize);
    const results = new Map();

    console.log(`Browser Save batch: ${selectedContentIds.join(', ')}`);
    try {
        await browserSaveCollector.warmUp();
    } catch (error) {
        console.error('Failed to warm up Figma browser:', error.message);
        for (const contentId of selectedContentIds) results.set(contentId, { error });
        return createPrefetchedSaveResult(selectedContentIds, results);
    }

    for (let index = 0; index < selectedContentIds.length; index++) {
        const contentId = selectedContentIds[index];
        try {
            const saves = await browserSaveCollector.fetchSaveCount(contentId);
            results.set(contentId, { saves });
            console.log(`Prefetched browser Saves for ${contentId}: ${saves}`);
        } catch (error) {
            results.set(contentId, { error });
            console.error(`Failed to prefetch browser Saves for ${contentId}:`, error.message);
            if (error.code === 'FIGMA_WAF_CHALLENGE' || error.code === 'FIGMA_WAF_CAPTCHA') {
                for (const deferredId of selectedContentIds.slice(index + 1)) {
                    const deferredError = new Error('Browser Save collection deferred after WAF challenge');
                    deferredError.code = 'SAVE_BROWSER_DEFERRED';
                    results.set(deferredId, { error: deferredError });
                }
                break;
            }
        }

        if (index < selectedContentIds.length - 1) {
            const delayMs = REALTIME_SAVE_DELAY_MS
                + Math.floor(Math.random() * (REALTIME_SAVE_DELAY_JITTER_MS + 1));
            await wait(delayMs);
        }
    }

    return createPrefetchedSaveResult(selectedContentIds, results);
}

function createPrefetchedSaveResult(contentIds, results) {
    return {
        contentIds,
        fetchSaveCount: async contentId => {
            const result = results.get(String(contentId));
            if (!result) throw new Error(`No prefetched browser Save result for ${contentId}`);
            if (result.error) throw result.error;
            return result.saves;
        }
    };
}

// 添加 CORS 支持
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-IC-Token');
    res.header('Access-Control-Max-Age', '86400');
    
    // 处理预检请求
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

// 解析 JSON 请求体
app.use('/api/plugin-events', express.json({ limit: '16kb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false, limit: '4kb' }));
const analyticsRelay = mountAnalyticsRelay(app);
const dashboardAuth = createDashboardAuth();

app.get('/', (req, res) => {
    return res.redirect(302, `${PRODUCT_BASE_PATH}/`);
});

app.get(PRODUCT_BASE_PATH, (req, res) => {
    if (!req.path.endsWith('/')) {
        return res.redirect(301, `${PRODUCT_BASE_PATH}/`);
    }
    if (dashboardAuth.isAuthenticated(req)) {
        return res.redirect(302, `${PRODUCT_BASE_PATH}/dashboard/`);
    }
    return res.sendFile(path.join(PUBLIC_DIRECTORY, 'landing.html'));
});

app.post(`${PRODUCT_BASE_PATH}/enter`, (req, res) => {
    const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
    const attempt = dashboardAuth.canAttempt(clientKey);

    if (!attempt.allowed) {
        res.set('Retry-After', String(attempt.retryAfterSeconds));
        return res.redirect(303, `${PRODUCT_BASE_PATH}/?error=limited`);
    }
    if (!dashboardAuth.isConfigured()) {
        return res.redirect(303, `${PRODUCT_BASE_PATH}/?error=unconfigured`);
    }
    if (!dashboardAuth.authenticate(req.body.password)) {
        dashboardAuth.recordFailure(clientKey);
        return res.redirect(303, `${PRODUCT_BASE_PATH}/?error=invalid`);
    }

    dashboardAuth.clearFailures(clientKey);
    dashboardAuth.issueCookie(req, res);
    return res.redirect(303, `${PRODUCT_BASE_PATH}/dashboard/`);
});

app.post(`${PRODUCT_BASE_PATH}/logout`, (req, res) => {
    dashboardAuth.clearCookie(req, res);
    return res.redirect(303, `${PRODUCT_BASE_PATH}/`);
});

app.get(`${PRODUCT_BASE_PATH}/dashboard`, dashboardAuth.requireAuth, (req, res) => {
    if (req.path.endsWith('/')) {
        return res.sendFile(path.join(PUBLIC_DIRECTORY, 'index.html'));
    }
    return res.redirect(301, `${PRODUCT_BASE_PATH}/dashboard/`);
});

app.get(`${PRODUCT_BASE_PATH}/users`, dashboardAuth.requireAuth, (req, res) => {
    if (req.path.endsWith('/')) {
        return res.sendFile(path.join(PUBLIC_DIRECTORY, 'users.html'));
    }
    return res.redirect(301, `${PRODUCT_BASE_PATH}/users/`);
});

// All collector pages and legacy/internal endpoints below this point require login.
// The plugin-events relay and its health check are mounted above and remain public.
app.use(dashboardAuth.requireAuth);
app.use(express.static(PUBLIC_DIRECTORY, { index: false }));

app.get('/api/plugin-data/analytics-users', (req, res) => {
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    try {
        const result = analyticsRelay.listUsers({
            query: req.query.q,
            sort: req.query.sort,
            limit,
            offset: (page - 1) * limit
        });
        return res.json({ ...result, page });
    } catch (error) {
        console.error('Unable to list analytics users:', error.message);
        return res.status(503).json({ error: 'Analytics user data is unavailable' });
    }
});

// 添加调试日志中间件
app.use((req, res, next) => {
    if (req.path !== '/api/plugin-events') {
        console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    }
    next();
});

// 存储数据
function storeData(data, currentTime) {
    const year = currentTime.getFullYear().toString();
    const month = (currentTime.getMonth() + 1).toString().padStart(2, '0');
    const day = currentTime.getDate().toString().padStart(2, '0');
    const time = currentTime.toTimeString().slice(0, 5).replace(/:/, '-');

    const dirPath = path.join(__dirname, 'data', year, month, day);

    try {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        const filePath = path.join(dirPath, `${time}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        updateDailyTrendSnapshot(DAILY_TRENDS_PATH, data, currentTime, REALTIME_SAVE_CONTENT_IDS);
        console.log('Data stored successfully:', filePath);
    } catch (error) {
        console.error('Failed to store data:', error);
    }
}

function storeDataAsEndOfDay(pluginData, previousDayTime, collectionTime) {
    // 计算前一天的日期
    const year = previousDayTime.getFullYear().toString();
    const month = (previousDayTime.getMonth() + 1).toString().padStart(2, '0');
    const day = previousDayTime.getDate().toString().padStart(2, '0');
    
    // 使用previousDayTime年月日作为存储路径
    const dirPath = path.join(__dirname, 'data', year, month, day);
    const filePath = path.join(dirPath, `24-00.json`); // 特意存为"24:00"标记一天的结束
    
    // 确保目录存在，如果不存在则递归创建
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    // 写入数据到文件
    fs.writeFileSync(filePath, JSON.stringify(pluginData, null, 2));
    updateDailyTrendSnapshot(
        DAILY_TRENDS_PATH,
        pluginData,
        collectionTime,
        REALTIME_SAVE_CONTENT_IDS,
        { day: formatLocalDate(previousDayTime) }
    );
}

function findDayEndData(dayTime) {
    const year = dayTime.getFullYear().toString();
    const month = (dayTime.getMonth() + 1).toString().padStart(2, '0');
    const day = dayTime.getDate().toString().padStart(2, '0');

    // 检查目录是否存在
    const dirPath = path.join(__dirname, 'data', year, month, day);
    if (!fs.existsSync(dirPath)) {
        console.log(`No data directory found for ${year}-${month}-${day}.`);
        return null;
    }

    // 读取目录中的所有文件，假设文件名是时间戳，如 "23-30.json"
    const files = fs.readdirSync(dirPath).filter(file => file.endsWith('.json'));
    if (files.length === 0) {
        console.log(`No data files found for ${year}-${month}-${day}.`);
        return null;
    }

    // 对文件名进行排序以找到最后一个文件，即最晚的数据点
    const lastFile = files.sort().pop();
    const filePath = path.join(dirPath, lastFile);
    const previousData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    return previousData;
}

function findLatestSuccessfulSaveData(currentTime) {
    const latestById = new Map();
    for (let daysAgo = 0; daysAgo <= 7; daysAgo++) {
        const date = new Date(currentTime);
        date.setDate(date.getDate() - daysAgo);
        const year = date.getFullYear().toString();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const dirPath = path.join(__dirname, 'data', year, month, day);
        if (!fs.existsSync(dirPath)) continue;

        const files = fs.readdirSync(dirPath)
            .filter(file => /^\d{2}-\d{2}\.json$/.test(file))
            .sort()
            .reverse();
        for (const file of files) {
            try {
                const plugins = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
                for (const plugin of plugins) {
                    if (
                        !latestById.has(plugin.id)
                        && plugin.saves !== null
                        && plugin.saves !== undefined
                        && plugin.saves !== ''
                        && plugin.saves !== '--'
                        && Number.isFinite(Number(plugin.saves))
                    ) {
                        latestById.set(plugin.id, plugin);
                    }
                }
            } catch (error) {
                console.warn(`Ignoring unreadable collection file ${file}:`, error.message);
            }
        }
    }
    return latestById.size > 0 ? [...latestById.values()] : null;
}

app.listen(port, host, () => {
    console.log(`Server is running on http://${host}:${port}`);
    console.log(`Dashboard password protection: ${dashboardAuth.isConfigured() ? 'enabled' : 'NOT CONFIGURED'}`);
    console.log('Available endpoints:');
    console.log(`- GET ${PRODUCT_BASE_PATH}/ (landing)`);
    console.log(`- GET ${PRODUCT_BASE_PATH}/dashboard/ (password protected)`);
    console.log(`- GET ${PRODUCT_BASE_PATH}/users/ (password protected)`);
    console.log('- GET /fetch-plugin-data');
    console.log('- GET /get-data');
    console.log('- GET /get-directory');
    console.log('- GET /get-save-watchlist');
    console.log('- GET /plugin-trends');
    console.log('- POST /api/plugin-events');
    console.log('- GET /api/plugin-data/analytics-users');
    console.log('- GET /analytics-healthz');
});

function startFetchTask() {
    scheduleAlignedTask(boundaryTimeMs => fetchData(new Date(boundaryTimeMs)), {
        onError: error => console.error('Error during scheduled fetch:', error)
    });
}

startFetchTask();

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
        console.log(`${signal} received; closing Save browser`);
        await browserSaveCollector.close();
        analyticsRelay.close();
        process.exit(0);
    });
}

async function fetchData(collectionTime = new Date()) {
    try {
        const now = collectionTime;
        const dayPlan = createCollectionDayPlan(now);
        const realtimePrefetch = await prefetchRealtimeSaveCounts(now);
        const lastSaveData = loadSaveCache() ?? findLatestSuccessfulSaveData(now);
        const saveOptions = {
            lastSaveData,
            fetchRealtimeSaveCount: realtimePrefetch.fetchSaveCount,
            realtimeContentIds: realtimePrefetch.contentIds,
            realtimeDelayMs: 0,
            realtimeDelayJitterMs: 0,
            stopOnRealtimeWaf: false
        };

        if (dayPlan.isMidnight) {
            const previousData = findDayEndData(dayPlan.comparisonDay);
            const sourceDate = formatLocalDate(dayPlan.completedDay);
            const endOfDayData = await fetchPluginData(previousData, {
                refreshWatchlist: true,
                watchlistSourceDate: sourceDate,
                ...saveOptions
            }); // 获取当前插件数据，并按上一完整日增长更新关注清单
            const startOfDayData = resetDailyGrowth(endOfDayData);
            storeSaveCache(endOfDayData);
            storeDataAsEndOfDay(endOfDayData, dayPlan.completedDay, now);
            storeData(startOfDayData, now);

        } else {
            const previousData = findDayEndData(dayPlan.comparisonDay);
            const pluginData = await fetchPluginData(previousData, saveOptions); // 获取当前插件数据
            storeSaveCache(pluginData);
            storeData(pluginData, now); // 将当前时间传递给storeData
        }
    } catch (error) {
        console.error('Error during fetchData:', error);
        throw error;
    }
}

// 读取指定日期和时间的数据
function readDataByDateTime(year, month, day, time) {
    const dirPath = path.join(__dirname, 'data', year, month, day);
    const fileName = `${time}.json`; // 时间格式应为 "HH-MM"，例如 "13-45.json"
    const filePath = path.join(dirPath, fileName);

    if (fs.existsSync(filePath)) {
        const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return fileData; // 返回该时间点的数据
    } else {
        return null; // 如果文件不存在，返回 null 或适当的默认值
    }
}

app.get(['/fetch-plugin-data', '/api/plugin-data/fetch-plugin-data'], async (req, res) => {
    console.log('Received request to fetch plugin data');
    try {
        await fetchData();
        console.log('Successfully fetched plugin data');
        res.json({ success: true });
    } catch (error) {
        console.error('Error fetching plugin data:', error);
        res.status(500).json({ error: 'Failed to fetch plugin data' });
    }
});

function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function fetchPluginData(previousData, options = {}) {
    console.log('Starting to fetch plugin data from API');
    
    const maxRetries = 10;
    const retryDelay = 400;
    
    async function attemptFetch() {
        try {
            const searchQueries = [
                { query: 'chart', limit: 15 },
                { query: 'animate', limit: 15 },
                { query: 'extrude', limit: 15 },
                { query: 'print', limit: 10 }
            ];

            let allPlugins = [];
            let totalPlugins = 0;

            function addPlugin(model) {
                const pluginId = model.id;
                if (allPlugins.some(plugin => plugin.id === pluginId)) return false;

                console.log(`Processing plugin: ${model.name} (ID: ${pluginId})`);

                const currentUsers = model.user_count || 0;
                const currentLikes = model.like_count || 0;
                const previousPlugin = previousData ? previousData.find(plugin => plugin.id === pluginId) : null;

                if (previousPlugin) {
                    console.log(`Found previous data for plugin ${model.name}:`, {
                        current_users: currentUsers,
                        previous_users: previousPlugin.users,
                        current_likes: currentLikes,
                        previous_likes: previousPlugin.likes
                    });
                }

                allPlugins.push({
                    id: pluginId,
                    contentId: model.content_id,
                    name: model.name,
                    users: currentUsers,
                    likes: currentLikes,
                    DoDCount: previousPlugin ? currentUsers - previousPlugin.users : '--',
                    DoDLikes: previousPlugin ? currentLikes - previousPlugin.likes : '--'
                });
                totalPlugins++;
                return true;
            }
            
            for (const { query, limit } of searchQueries) {
                console.log(`\n=== Processing query: ${query} ===`);
                const url = `https://www.figma.com/api/search/resources?query=${encodeURIComponent(query)}&price=all&creators=all&sort_by=relevancy&resource_type=plugin`;
                
                try {
                    console.log(`Making API request to: ${url}`);
                    const response = await axios.get(url, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Accept': 'application/json',
                            'Referer': 'https://www.figma.com/',
                            'Origin': 'https://www.figma.com'
                        },
                        timeout: 10000
                    });

                    console.log('API Response status:', response.status);
                    
                    if (!response.data) {
                        console.error('No data in response');
                        throw new Error('No data in response');
                    }

                    // 检查响应数据结构
                    console.log('Response data structure:', Object.keys(response.data));
                    
                    // 检查是否有错误
                    if (response.data.error) {
                        console.error('API Error:', response.data.error);
                        console.error('API Status:', response.data.status);
                        throw new Error(`API Error: ${response.data.error}`);
                    }

                    // 检查是否有结果
                    if (!response.data.meta || !response.data.meta.results) {
                        console.error('No results in response. Full response:', JSON.stringify(response.data, null, 2));
                        throw new Error('No results in response');
                    }

                    // 获取插件数据
                    const plugins = response.data.meta.results;
                    console.log(`\nFound ${plugins.length} plugins for query "${query}"`);
                    
                    // 按关键词配置的数量处理插件
                    let keywordCount = 0;
                    for (const plugin of plugins) {
                        if (keywordCount >= limit) break;
                        
                        // 检查是否已经添加过这个插件
                        if (allPlugins.some(p => p.id === plugin.model.id)) {
                            console.log(`Skipping duplicate plugin: ${plugin.model.name}`);
                            continue;
                        }

                        if (addPlugin(plugin.model)) {
                            keywordCount++;
                            console.log(`Added plugin ${plugin.model.name} to collection. Total plugins: ${totalPlugins}, Keyword count: ${keywordCount}`);
                        }
                    }

                } catch (error) {
                    console.error(`Error processing query "${query}":`, error.message);
                    throw error; // 重新抛出错误以触发重试
                }
            }

            for (const fixedPlugin of FIXED_PLUGINS) {
                if (allPlugins.some(plugin => plugin.contentId === fixedPlugin.contentId)) continue;

                const url = `https://www.figma.com/api/search/resources?query=${encodeURIComponent(fixedPlugin.searchQuery)}&price=all&creators=all&sort_by=relevancy&resource_type=plugin`;
                console.log(`Fetching fixed plugin ${fixedPlugin.contentId}`);
                const response = await axios.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept': 'application/json',
                        'Referer': 'https://www.figma.com/',
                        'Origin': 'https://www.figma.com'
                    },
                    timeout: 10000
                });
                const fixedResult = response.data?.meta?.results?.find(
                    result => String(result.model?.content_id) === fixedPlugin.contentId
                );
                if (!fixedResult) {
                    throw new Error(`Fixed plugin ${fixedPlugin.contentId} was not found`);
                }
                addPlugin(fixedResult.model);
                console.log(`Added fixed plugin ${fixedResult.model.name}. Total plugins: ${totalPlugins}`);
            }

            // 验证是否成功获取到数据
            if (allPlugins.length === 0) {
                throw new Error('No plugins collected from any query');
            }

            console.log(`\nTotal plugins collected: ${allPlugins.length}`);

            let watchlist = loadWatchlist();
            if (options.refreshWatchlist || !watchlist) {
                const sourceDate = options.watchlistSourceDate || `bootstrap-${formatLocalDate(new Date())}`;
                watchlist = buildWatchlist(allPlugins, sourceDate);
                storeWatchlist(watchlist);
            } else if (addMandatoryPluginsToWatchlist(watchlist, allPlugins)) {
                storeWatchlist(watchlist);
            }

            await collectSaveCounts(allPlugins, watchlist, previousData, {
                lastSaveData: options.lastSaveData,
                fetchRealtimeSaveCount: options.fetchRealtimeSaveCount,
                realtimeContentIds: options.realtimeContentIds,
                realtimeDelayMs: options.realtimeDelayMs,
                realtimeDelayJitterMs: options.realtimeDelayJitterMs,
                stopOnRealtimeWaf: options.stopOnRealtimeWaf
            });
            return allPlugins;

        } catch (error) {
            console.error('Error in fetchPluginData attempt:', error);
            throw error;
        }
    }

    // 重试逻辑
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Attempt ${attempt}/${maxRetries} to fetch plugin data`);
            const result = await attemptFetch();
            console.log(`Successfully fetched plugin data on attempt ${attempt}`);
            return result;
        } catch (error) {
            console.error(`Attempt ${attempt} failed:`, error.message);
            
            if (attempt === maxRetries) {
                console.error(`All ${maxRetries} attempts failed. Giving up.`);
                throw new Error(`Failed to fetch plugin data after ${maxRetries} attempts: ${error.message}`);
            }
            
            console.log(`Waiting ${retryDelay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
}

function constructDirectory() {
    const basePath = path.join(__dirname, 'data');
    let directory = {};

    function exploreDirectory(dirPath, current) {
        fs.readdirSync(dirPath, { withFileTypes: true }).forEach(dirent => {
            if (dirent.isDirectory()) {
                const nextPath = path.join(dirPath, dirent.name);
                if (!current[dirent.name]) current[dirent.name] = {};
                exploreDirectory(nextPath, current[dirent.name]);
            } else {
                // 确保只处理以 '.json' 结尾的文件
                if (dirent.name.endsWith('.json')) {
                    if (!current.times) current.times = [];
                    current.times.push(dirent.name.replace('.json', ''));
                }
            }
        });
    }

    exploreDirectory(basePath, directory);
    return directory;
}

app.get(['/get-data', '/api/plugin-data/get-data'], async (req, res) => {
    const { year, month, day, time } = req.query;
    try {
        const data = readDataByDateTime(year, month, day, time);
        res.json(data);
    } catch (error) {
        console.error("Error fetching data:", error);
        res.status(500).json({ error: "Failed to fetch data" });
    }
});

app.get(['/get-directory', '/api/plugin-data/get-directory'], (req, res) => {
    try {
        const directory = constructDirectory();
        res.json(directory);
    } catch (error) {
        console.error('Failed to construct directory:', error);
        res.status(500).json({ error: 'Failed to get directory' });
    }
});

app.get(['/get-save-watchlist', '/api/plugin-data/get-save-watchlist'], (req, res) => {
    const watchlist = loadWatchlist();
    if (!watchlist) {
        return res.status(404).json({ error: 'Save watchlist has not been created yet' });
    }
    res.json(watchlist);
});

app.get(['/plugin-trends', '/api/plugin-data/plugin-trends'], (req, res) => {
    try {
        const metric = String(req.query.metric || 'saves');
        const mode = String(req.query.mode || 'hourly');

        if (!['users', 'likes', 'saves'].includes(metric)) {
            return res.status(400).json({ error: 'metric must be users, likes or saves' });
        }

        if (mode === 'hourly') {
            const day = String(req.query.day || formatLocalDate(new Date()));
            const trends = getHourlyTrends(DATA_DIRECTORY, day, metric, REALTIME_SAVE_CONTENT_IDS);
            return res.json({ metric, mode, day, ...trends });
        }

        if (mode === 'daily') {
            const requestedDays = parseInt(req.query.days || '30', 10);
            const days = Number.isFinite(requestedDays)
                ? Math.max(1, Math.min(365, requestedDays))
                : 30;
            const trends = getDailyTrends(
                DAILY_TRENDS_PATH,
                DATA_DIRECTORY,
                days,
                metric,
                REALTIME_SAVE_CONTENT_IDS
            );
            return res.json({ metric, mode, days, ...trends });
        }

        return res.status(400).json({ error: 'mode must be hourly or daily' });
    } catch (error) {
        console.error('Failed to load plugin trends:', error);
        res.status(500).json({ error: 'Failed to load plugin trends' });
    }
});

function deleteTimeData(year, month, day, time) {
    const filePath = path.join(__dirname, 'data', year, month, day, `${time}.json`);
    if (fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
            console.log(`Successfully deleted data file: ${filePath}`);
            
            // 检查目录是否为空
            const dirPath = path.join(__dirname, 'data', year, month, day);
            const remainingFiles = fs.readdirSync(dirPath);
            if (remainingFiles.length === 0) {
                // 如果目录为空，删除目录
                fs.rmdirSync(dirPath);
                console.log(`Removed empty directory: ${dirPath}`);
                
                // 检查上一级目录是否为空
                const monthPath = path.join(__dirname, 'data', year, month);
                const remainingDays = fs.readdirSync(monthPath);
                if (remainingDays.length === 0) {
                    fs.rmdirSync(monthPath);
                    console.log(`Removed empty month directory: ${monthPath}`);
                    
                    // 检查年份目录是否为空
                    const yearPath = path.join(__dirname, 'data', year);
                    const remainingMonths = fs.readdirSync(yearPath);
                    if (remainingMonths.length === 0) {
                        fs.rmdirSync(yearPath);
                        console.log(`Removed empty year directory: ${yearPath}`);
                    }
                }
            }
            return true;
        } catch (error) {
            console.error('Error deleting data:', error);
            return false;
        }
    }
    return false;
}

app.delete(['/delete-time-data', '/api/plugin-data/delete-time-data'], (req, res) => {
    const { year, month, day, time } = req.query;
    console.log(`Received request to delete data for ${year}/${month}/${day} ${time}`);
    
    if (!year || !month || !day || !time) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing required parameters' 
        });
    }

    try {
        const success = deleteTimeData(year, month, day, time);
        if (success) {
            res.json({ 
                success: true, 
                message: 'Data deleted successfully' 
            });
        } else {
            res.status(404).json({ 
                success: false, 
                error: 'Data not found' 
            });
        }
    } catch (error) {
        console.error('Error in delete endpoint:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

app.post('/track', (req, res) => {
    try {
      // 简易鉴权（如不需要可移除）
      const TOKEN = 'iCharts';
      if (req.headers['x-ic-token'] !== TOKEN) return res.status(401).json({ ok: false });
  
      const { event_name, active_chart_type_id, client_ts } = req.body || {};
      if (!event_name) return res.status(400).json({ ok: false, error: 'event_name required' });
  
      const now = new Date();
      const ts = Number.isFinite(+client_ts) ? new Date(client_ts) : now; // 统一用UTC聚合
  
      // 如需原始事件落盘，可启用：
      // const y = ts.getUTCFullYear().toString();
      // const m = String(ts.getUTCMonth() + 1).padStart(2, '0');
      // const d = String(ts.getUTCDate()).padStart(2, '0');
      // const hh = String(ts.getUTCHours()).padStart(2, '0');
      // const mm = String(ts.getUTCMinutes()).padStart(2, '0');
      // const dd = path.join(EVENTS_BASE, y, m, d); ensureDir(dd);
      // fs.writeFileSync(path.join(dd, `${hh}-${mm}-${Date.now()}.json`), JSON.stringify({ event_name, active_chart_type_id, client_ts: ts.toISOString(), server_ts: now.toISOString() }, null, 2));
  
      upsertCounters(event_name, active_chart_type_id, ts);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false });
    }
  });
  
  // 小时统计（读取预聚合）
  app.get('/stats/hourly', (req, res) => {
    try {
      const day = req.query.day; // YYYY-MM-DD (UTC)
      if (!day) return res.status(400).json({ error: 'day required' });
      const dayPath = path.join(COUNTERS_BASE, `${day}.json`);
      if (!fs.existsSync(dayPath)) {
        return res.json({ day, hourly: Array(24).fill(0), byEvent: {}, byChartType: {} });
      }
      const ctr = JSON.parse(fs.readFileSync(dayPath, 'utf8'));
      res.json({ day: ctr.day, hourly: ctr.hours, byEvent: ctr.byEvent, byChartType: ctr.byChartType });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'fail' });
    }
  });
  
  // 日统计（读取预聚合）
  app.get('/stats/daily', (req, res) => {
    try {
      const days = Math.max(1, Math.min(365, parseInt(req.query.days || '30', 10)));
      const out = [];
      const now = new Date();
      const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  
      for (let i = 0; i < days; i++) {
        const d = new Date(todayUTC);
        d.setUTCDate(todayUTC.getUTCDate() - i);
        const dayStr = d.toISOString().slice(0, 10);
        const dayPath = path.join(COUNTERS_BASE, `${dayStr}.json`);
        let total = 0;
        if (fs.existsSync(dayPath)) {
          try { total = JSON.parse(fs.readFileSync(dayPath, 'utf8')).total || 0; } catch {}
        }
        out.push({ day: dayStr, count: total });
      }
      res.json({ days: out.reverse() });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'fail' });
    }
  });

  // GA4 转发接口（用于国内用户）
  // 接收来自 Figma 插件的 GA4 事件数据，转发到 Google Analytics
  // 处理 OPTIONS 预检请求
  app.options('/ga-proxy', (req, res) => {
    res.status(204).end();
  });

  app.post('/ga-proxy', async (req, res) => {
    try {
      // CORS 已经在全局中间件中处理
      
      // 获取 GA4 配置（可以从环境变量或配置文件读取）
      const MEASUREMENT_ID = process.env.MEASUREMENT_ID;
      const API_SECRET = process.env.API_SECRET;
      if (!MEASUREMENT_ID || !API_SECRET) {
        return res.status(503).json({ ok: false, error: 'GA4 proxy is not configured' });
      }

      // 接收客户端发送的 GA4 请求体
      const requestBody = req.body;
      
      // 构建转发到 Google Analytics 的 URL
      const gaUrl = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(MEASUREMENT_ID)}&api_secret=${encodeURIComponent(API_SECRET)}`;
      
      // 转发请求到 Google Analytics
      try {
        const response = await axios.post(gaUrl, requestBody, {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 10000 // 10秒超时
        });
        
        // GA 通常返回 204 No Content
        return res.status(response.status || 204).json({ ok: true, forwarded: true });
      } catch (gaError) {
        // 如果无法访问 Google Analytics，记录错误但仍返回成功（避免客户端重试）
        console.error('Failed to forward to GA4:', gaError.message);
        return res.status(202).json({ 
          ok: true, 
          forwarded: false, 
          error: 'GA4 unreachable from server',
          note: 'Event received but not forwarded to GA4'
        });
      }
    } catch (e) {
      console.error('GA4 proxy error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 测试接口：验证服务器是否能访问 Google Analytics
  app.get('/test-ga-access', async (req, res) => {
    try {
      const gaUrl = 'https://www.google-analytics.com/mp/collect';
      const response = await axios.get(gaUrl, {
        timeout: 5000,
        validateStatus: () => true // 接受任何状态码
      });
      
      return res.json({ 
        accessible: true, 
        status: response.status,
        message: 'Server can access Google Analytics'
      });
    } catch (e) {
      return res.json({ 
        accessible: false, 
        error: e.message,
        message: 'Server cannot access Google Analytics (may need proxy/VPN)'
      });
    }
  });
