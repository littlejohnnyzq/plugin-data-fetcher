const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const app = express();
const port = 1086;

// 添加 CORS 支持
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

app.use(express.static('public'));

// 添加调试日志中间件
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

const dataFilePath = path.join(__dirname, 'structured_data.json');

const puppeteerConfig = {
    headless: true,
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process'],
};

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
        console.log('Data stored successfully:', filePath);
    } catch (error) {
        console.error('Failed to store data:', error);
    }
}

function storeDataAsEndOfDay(pluginData, previousDayTime) {
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
}

function findPreviousData(currentTime) {
    previousDay = new Date(currentTime.getTime() - 86400000); // 减去一天的毫秒数

    const year = previousDay.getFullYear().toString();
    const month = (previousDay.getMonth() + 1).toString().padStart(2, '0');
    const day = previousDay.getDate().toString().padStart(2, '0');

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

app.listen(1086, '0.0.0.0', () => {
    console.log(`Server is running on http://localhost:${port}`);
    console.log('Available endpoints:');
    console.log('- GET /test');
    console.log('- GET /fetch-plugin-data');
    console.log('- GET /get-data');
    console.log('- GET /get-directory');
});

function startFetchTask() {
    const now = new Date();
    const millisTillNextHalfHour = 1800000 - (now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds()) % 1800000;

    setTimeout(async () => {
        await fetchData(); // 在接下来的半小时点执行
        setInterval(async () => {
            await fetchData(); // 每半小时执行一次
        }, 1800000);
    }, millisTillNextHalfHour);
}

startFetchTask();

async function fetchData() {
    try {
        const now = new Date();
        const isMidnight = now.getHours() === 0 && now.getMinutes() === 0;

        if (isMidnight) {
            const previousDayTime = new Date(now.getTime() - 86400000); // 减去一天的毫秒数
            const previousData = findPreviousData(previousDayTime); // 改为传递当前时间
            const pluginData = await fetchPluginData(previousData); // 获取当前插件数据
            storeData(pluginData, now); // 将当前时间传递给storeData
            storeDataAsEndOfDay(pluginData, previousDayTime); // 特殊处理：同时存储数据作为上一天的最后数据点

        } else {
            const previousData = findPreviousData(now); // 改为传递当前时间
            const pluginData = await fetchPluginData(previousData); // 获取当前插件数据
            storeData(pluginData, now); // 将当前时间传递给storeData
        }
    } catch (error) {
        console.error('Error during fetchData:', error);
        // 这里你可以添加更多错误处理逻辑，比如记录错误到日志文件等
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

app.get('/fetch-plugin-data', async (req, res) => {
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

async function fetchPluginData(previousData) {
    console.log('Starting to fetch plugin data from API');
    
    const maxRetries = 10;
    const retryDelay = 400;
    
    async function attemptFetch() {
        try {
            const searchQueries = [
                'chart',
                'animate',
                'extrude'
            ];

            let allPlugins = [];
            let totalPlugins = 0;
            
            for (const query of searchQueries) {
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
                    
                    // 处理每个插件，每个关键词最多取15个
                    let keywordCount = 0;
                    for (const plugin of plugins) {
                        if (keywordCount >= 15) break;  // 每个关键词最多取15个
                        
                        const pluginId = plugin.model.id;
                        // 检查是否已经添加过这个插件
                        if (allPlugins.some(p => p.id === pluginId)) {
                            console.log(`Skipping duplicate plugin: ${plugin.model.name}`);
                            continue;
                        }

                        console.log(`Processing plugin: ${plugin.model.name} (ID: ${pluginId})`);
                        
                        const currentUsers = plugin.model.user_count || 0;
                        const currentLikes = plugin.model.like_count || 0;
                        const previousPlugin = previousData ? previousData.find(p => p.id === pluginId) : null;
                        
                        if (previousPlugin) {
                            console.log(`Found previous data for plugin ${plugin.model.name}:`, {
                                current_users: currentUsers,
                                previous_users: previousPlugin.users,
                                current_likes: currentLikes,
                                previous_likes: previousPlugin.likes
                            });
                        }

                        const processedPlugin = {
                            id: pluginId,
                            name: plugin.model.name,
                            users: currentUsers,
                            likes: currentLikes,
                            DoDCount: previousPlugin ? currentUsers - previousPlugin.users : "--",
                            DoDLikes: previousPlugin ? currentLikes - previousPlugin.likes : "--"
                        };

                        allPlugins.push(processedPlugin);
                        totalPlugins++;
                        keywordCount++;
                        console.log(`Added plugin ${plugin.model.name} to collection. Total plugins: ${totalPlugins}, Keyword count: ${keywordCount}`);
                    }

                } catch (error) {
                    console.error(`Error processing query "${query}":`, error.message);
                    throw error; // 重新抛出错误以触发重试
                }
            }

            // 验证是否成功获取到数据
            if (allPlugins.length === 0) {
                throw new Error('No plugins collected from any query');
            }

            console.log(`\nTotal plugins collected: ${allPlugins.length}`);
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

app.get('/get-data', async (req, res) => {
    const { year, month, day, time } = req.query;
    try {
        const data = readDataByDateTime(year, month, day, time);
        res.json(data);
    } catch (error) {
        console.error("Error fetching data:", error);
        res.status(500).json({ error: "Failed to fetch data" });
    }
});

app.get('/get-directory', (req, res) => {
    try {
        const directory = constructDirectory();
        res.json(directory);
    } catch (error) {
        console.error('Failed to construct directory:', error);
        res.status(500).json({ error: 'Failed to get directory' });
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

app.delete('/delete-time-data', (req, res) => {
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
      // if (req.headers['x-ic-token'] !== TOKEN) return res.status(401).json({ ok: false });
  
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