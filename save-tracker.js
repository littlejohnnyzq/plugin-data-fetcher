const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DEFAULT_RETRIES = 3;
const DEFAULT_REALTIME_DELAY_MS = 2000;
const DEFAULT_WAF_COOLDOWN_MS = 60000;
const REALTIME_SAVE_BATCH_SIZE = 5;
const REALTIME_SAVE_DELAY_MS = 6000;
const REALTIME_SAVE_DELAY_JITTER_MS = 3000;
const WATCH_RATIO = 0.5;
const HIGH_USER_THRESHOLD = 50000;
const ALWAYS_WATCHED_CONTENT_IDS = new Set([
    '1370606842652257742',
    '1387823712562916211',
    '1414925802794094447',
    '1473659572195493091',
    '731451122947612104',
    '1404821057322599271',
    '1249759048471403961',
    '988173868842375596',
    '961270034818256057',
    '874441781480244375'
]);
const REALTIME_SAVE_CONTENT_IDS = new Set(ALWAYS_WATCHED_CONTENT_IDS);
const WATCHLIST_PATH = path.join(__dirname, 'state', 'save-watchlist.json');
const SAVE_CACHE_PATH = path.join(__dirname, 'state', 'save-last-success.json');

function selectRealtimeSaveBatch(contentIds, currentTime, batchSize = REALTIME_SAVE_BATCH_SIZE) {
    if (contentIds.length === 0) return [];
    const safeBatchSize = Math.min(Math.max(1, batchSize), contentIds.length);
    const batchNumber = Math.floor(currentTime.getTime() / 1800000);
    const offset = (batchNumber * safeBatchSize) % contentIds.length;
    const orderedContentIds = [
        ...contentIds.slice(offset),
        ...contentIds.slice(0, offset)
    ];
    return orderedContentIds.slice(0, safeBatchSize);
}

function calculateJitteredDelay(baseDelayMs, jitterMs, random = Math.random) {
    return baseDelayMs + Math.floor(random() * (jitterMs + 1));
}

function toFiniteNumber(value) {
    if (value === null || value === undefined || value === '' || value === '--') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function buildWatchlist(plugins, sourceDate) {
    const rankedPlugins = [...plugins].sort((a, b) => {
        const growthDifference = (toFiniteNumber(b.DoDCount) ?? 0) - (toFiniteNumber(a.DoDCount) ?? 0);
        if (growthDifference !== 0) return growthDifference;

        const usersDifference = (toFiniteNumber(b.users) ?? 0) - (toFiniteNumber(a.users) ?? 0);
        if (usersDifference !== 0) return usersDifference;

        return String(a.id).localeCompare(String(b.id));
    });
    const topGrowthCount = Math.ceil(rankedPlugins.length * WATCH_RATIO);
    const topGrowthIds = new Set(rankedPlugins.slice(0, topGrowthCount).map(plugin => plugin.id));
    const watchedPlugins = rankedPlugins.filter(plugin => (
        topGrowthIds.has(plugin.id)
        || (toFiniteNumber(plugin.users) ?? 0) > HIGH_USER_THRESHOLD
        || ALWAYS_WATCHED_CONTENT_IDS.has(String(plugin.contentId))
    ));

    return {
        updatedAt: new Date().toISOString(),
        sourceDate,
        ratio: WATCH_RATIO,
        totalPlugins: rankedPlugins.length,
        topGrowthCount,
        watchedCount: watchedPlugins.length,
        plugins: watchedPlugins.map(plugin => ({
            id: plugin.id,
            contentId: plugin.contentId,
            name: plugin.name,
            previousDayNewUsers: toFiniteNumber(plugin.DoDCount) ?? 0,
            watchReasons: [
                topGrowthIds.has(plugin.id) ? 'top-growth-50-percent' : null,
                (toFiniteNumber(plugin.users) ?? 0) > HIGH_USER_THRESHOLD ? 'users-over-50000' : null,
                ALWAYS_WATCHED_CONTENT_IDS.has(String(plugin.contentId)) ? 'fixed-plugin' : null
            ].filter(Boolean)
        }))
    };
}

function addMandatoryPluginsToWatchlist(watchlist, plugins) {
    const watchedById = new Map(watchlist.plugins.map(plugin => [plugin.id, plugin]));
    let changed = false;

    for (const plugin of plugins) {
        const reasons = [
            (toFiniteNumber(plugin.users) ?? 0) > HIGH_USER_THRESHOLD ? 'users-over-50000' : null,
            ALWAYS_WATCHED_CONTENT_IDS.has(String(plugin.contentId)) ? 'fixed-plugin' : null
        ].filter(Boolean);
        if (reasons.length === 0) continue;

        const watchedPlugin = watchedById.get(plugin.id);
        if (!watchedPlugin) {
            const newWatchedPlugin = {
                id: plugin.id,
                contentId: plugin.contentId,
                name: plugin.name,
                previousDayNewUsers: toFiniteNumber(plugin.DoDCount) ?? 0,
                watchReasons: reasons
            };
            watchlist.plugins.push(newWatchedPlugin);
            watchedById.set(plugin.id, newWatchedPlugin);
            changed = true;
            continue;
        }

        const existingReasons = new Set(watchedPlugin.watchReasons ?? []);
        for (const reason of reasons) {
            if (!existingReasons.has(reason)) {
                existingReasons.add(reason);
                changed = true;
            }
        }
        watchedPlugin.watchReasons = [...existingReasons];
    }

    watchlist.totalPlugins = plugins.length;
    watchlist.watchedCount = watchlist.plugins.length;
    return changed;
}

function loadWatchlist() {
    if (!fs.existsSync(WATCHLIST_PATH)) return null;

    try {
        const watchlist = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
        return Array.isArray(watchlist.plugins) ? watchlist : null;
    } catch (error) {
        console.error('Failed to load Save watchlist:', error.message);
        return null;
    }
}

function storeWatchlist(watchlist) {
    const stateDirectory = path.dirname(WATCHLIST_PATH);
    fs.mkdirSync(stateDirectory, { recursive: true });

    const temporaryPath = `${WATCHLIST_PATH}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(watchlist, null, 2));
    fs.renameSync(temporaryPath, WATCHLIST_PATH);
    console.log(`Save watchlist updated: ${watchlist.watchedCount}/${watchlist.totalPlugins} plugins (${watchlist.sourceDate})`);
}

function loadSaveCache() {
    if (!fs.existsSync(SAVE_CACHE_PATH)) return null;

    try {
        const cache = JSON.parse(fs.readFileSync(SAVE_CACHE_PATH, 'utf8'));
        if (!Array.isArray(cache.plugins)) return null;
        const browserPlugins = cache.plugins.filter(plugin => plugin.saveSource === 'figma-browser');
        return browserPlugins.length > 0 ? browserPlugins : null;
    } catch (error) {
        console.error('Failed to load Save cache:', error.message);
        return null;
    }
}

function storeSaveCache(plugins) {
    const cachedPlugins = plugins
        .filter(plugin => (
            plugin.isSaveTracked
            && plugin.saveSource === 'figma-browser'
            && toFiniteNumber(plugin.saves) !== null
        ))
        .map(plugin => ({
            id: plugin.id,
            contentId: plugin.contentId,
            name: plugin.name,
            saves: plugin.saves,
            saveSource: plugin.saveSource,
            saveCollectedAt: plugin.saveCollectedAt
        }));
    fs.mkdirSync(path.dirname(SAVE_CACHE_PATH), { recursive: true });
    const temporaryPath = `${SAVE_CACHE_PATH}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({
        updatedAt: new Date().toISOString(),
        plugins: cachedPlugins
    }, null, 2));
    fs.renameSync(temporaryPath, SAVE_CACHE_PATH);
}

function extractSaveCount(html) {
    const scriptPattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = scriptPattern.exec(html)) !== null) {
        try {
            const jsonLd = JSON.parse(match[1]);
            const documents = Array.isArray(jsonLd) ? jsonLd : [jsonLd];

            for (const document of documents) {
                const graph = Array.isArray(document?.['@graph']) ? document['@graph'] : [];
                const nodes = [document, ...graph];
                const statistics = nodes.flatMap(node => {
                    if (Array.isArray(node?.interactionStatistic)) return node.interactionStatistic;
                    return node?.interactionStatistic ? [node.interactionStatistic] : [];
                });
                const saveStatistic = statistics.find(statistic => {
                    const interactionType = statistic?.interactionType;
                    if (typeof interactionType === 'string') return interactionType.endsWith('/UseAction');
                    return interactionType?.['@type'] === 'UseAction';
                });
                const saveCount = toFiniteNumber(saveStatistic?.userInteractionCount);
                if (saveCount !== null) return saveCount;
            }
        } catch (error) {
            console.warn('Ignoring invalid JSON-LD while reading Save count:', error.message);
        }
    }

    return null;
}

async function fetchSaveCountFromFigma(contentId, options = {}) {
    const retries = options.retries ?? DEFAULT_RETRIES;
    const request = options.request ?? axios.get;
    const url = `https://www.figma.com/community/plugin/${encodeURIComponent(contentId)}`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await request(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://www.figma.com/community'
                },
                responseType: 'text',
                timeout: 10000
            });
            if (response.status === 202 || response.headers?.['x-amzn-waf-action'] === 'challenge') {
                const wafError = new Error('Figma WAF challenge');
                wafError.code = 'FIGMA_WAF_CHALLENGE';
                throw wafError;
            }
            const saveCount = extractSaveCount(response.data);
            if (saveCount === null) throw new Error('UseAction count not found in JSON-LD');
            return saveCount;
        } catch (error) {
            if (error.code === 'FIGMA_WAF_CHALLENGE' || attempt === retries) throw error;
            await new Promise(resolve => setTimeout(resolve, 500 * (2 ** (attempt - 1))));
        }
    }

    return null;
}

async function mapWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runWorker() {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex++;
            results[currentIndex] = await worker(items[currentIndex], currentIndex);
        }
    }

    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    await Promise.all(Array.from({ length: workerCount }, runWorker));
    return results;
}

async function collectSaveCounts(plugins, watchlist, previousData, options = {}) {
    const watchedIds = new Set((watchlist?.plugins ?? []).map(plugin => plugin.id));
    const previousById = new Map(
        (previousData ?? [])
            .filter(plugin => plugin.saveSource === 'figma-browser')
            .map(plugin => [plugin.id, plugin])
    );
    const lastSuccessfulById = new Map(
        (options.lastSaveData ?? [])
            .filter(plugin => plugin.saveSource === 'figma-browser')
            .map(plugin => [plugin.id, plugin])
    );
    const requestedRealtimeContentIds = options.realtimeContentIds
        ? new Set(options.realtimeContentIds.map(String))
        : null;
    const watchedPlugins = plugins.filter(plugin => watchedIds.has(plugin.id));
    const realtimePlugins = watchedPlugins.filter(plugin => (
        REALTIME_SAVE_CONTENT_IDS.has(String(plugin.contentId))
        && (!requestedRealtimeContentIds || requestedRealtimeContentIds.has(String(plugin.contentId)))
    ));

    for (const plugin of plugins) {
        const lastSuccessful = lastSuccessfulById.get(plugin.id);
        const lastSaves = toFiniteNumber(lastSuccessful?.saves);
        const previousSaves = toFiniteNumber(previousById.get(plugin.id)?.saves);
        plugin.isSaveTracked = watchedIds.has(plugin.id);
        plugin.saves = plugin.isSaveTracked ? lastSaves : null;
        plugin.DoDSaves = lastSaves === null || previousSaves === null ? '--' : lastSaves - previousSaves;
        plugin.saveSource = plugin.isSaveTracked ? lastSuccessful?.saveSource ?? null : null;
        plugin.saveStatus = plugin.isSaveTracked
            ? (lastSaves === null ? 'pending' : 'carried-forward')
            : 'not-tracked';
        plugin.saveError = null;
        plugin.saveCollectedAt = plugin.isSaveTracked ? lastSuccessful?.saveCollectedAt ?? null : null;
    }

    async function collectPlugin(plugin, fetcher, source, successStatus = 'ok') {
        if (!plugin.contentId) {
            plugin.saveStatus = 'failed';
            console.warn(`Cannot collect Save count without contentId: ${plugin.name}`);
            return;
        }

        try {
            const saves = await fetcher(plugin.contentId);
            const previousSaves = toFiniteNumber(previousById.get(plugin.id)?.saves);
            plugin.saves = saves;
            plugin.DoDSaves = previousSaves === null ? '--' : saves - previousSaves;
            plugin.saveSource = source;
            plugin.saveStatus = successStatus;
            plugin.saveError = null;
            plugin.saveCollectedAt = new Date().toISOString();
            console.log(`Collected Saves for ${plugin.name} from ${source}: ${saves}`);
            return null;
        } catch (error) {
            plugin.saveStatus = toFiniteNumber(plugin.saves) === null ? 'failed' : 'stale';
            plugin.saveError = error.message;
            console.error(`Failed to collect Saves for ${plugin.name} from ${source}:`, error.message);
            return error;
        }
    }

    const realtimeFetcher = options.fetchRealtimeSaveCount ?? fetchSaveCountFromFigma;
    const rotationOffset = realtimePlugins.length === 0
        ? 0
        : (options.realtimeRotationOffset ?? Math.floor(Date.now() / 1800000)) % realtimePlugins.length;
    const orderedRealtimePlugins = [
        ...realtimePlugins.slice(rotationOffset),
        ...realtimePlugins.slice(0, rotationOffset)
    ];

    for (let index = 0; index < orderedRealtimePlugins.length; index++) {
        const plugin = orderedRealtimePlugins[index];
        let error = await collectPlugin(plugin, realtimeFetcher, 'figma-browser');

        if (error?.code === 'FIGMA_WAF_CHALLENGE' && options.retryRealtimeWaf === true) {
            const cooldownMs = options.wafCooldownMs ?? DEFAULT_WAF_COOLDOWN_MS;
            console.warn(`Figma WAF challenge detected; cooling down for ${cooldownMs}ms before retrying ${plugin.name}`);
            await new Promise(resolve => setTimeout(resolve, cooldownMs));
            error = await collectPlugin(plugin, realtimeFetcher, 'figma-browser');
        } else if (error?.code === 'FIGMA_WAF_CHALLENGE' && options.stopOnRealtimeWaf !== false) {
            console.warn('Stopping browser Save collection for this run after a Figma WAF challenge');
            break;
        } else if (error?.code === 'SAVE_BROWSER_UNAVAILABLE') {
            console.warn('Stopping browser Save collection because Chromium is unavailable');
            break;
        }

        if (index < orderedRealtimePlugins.length - 1) {
            const baseDelayMs = options.realtimeDelayMs ?? DEFAULT_REALTIME_DELAY_MS;
            const jitterMs = options.realtimeDelayJitterMs
                ?? (options.realtimeDelayMs === undefined ? 2000 : 0);
            const delayMs = baseDelayMs + Math.floor(Math.random() * (jitterMs + 1));
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    return plugins;
}

module.exports = {
    ALWAYS_WATCHED_CONTENT_IDS,
    HIGH_USER_THRESHOLD,
    REALTIME_SAVE_BATCH_SIZE,
    REALTIME_SAVE_CONTENT_IDS,
    REALTIME_SAVE_DELAY_JITTER_MS,
    REALTIME_SAVE_DELAY_MS,
    SAVE_CACHE_PATH,
    WATCHLIST_PATH,
    addMandatoryPluginsToWatchlist,
    buildWatchlist,
    calculateJitteredDelay,
    collectSaveCounts,
    extractSaveCount,
    fetchSaveCountFromFigma,
    loadWatchlist,
    loadSaveCache,
    mapWithConcurrency,
    selectRealtimeSaveBatch,
    storeSaveCache,
    storeWatchlist
};
