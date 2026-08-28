const fs = require('fs');
const path = require('path');

const METRICS = new Set(['users', 'likes', 'saves']);
const MAX_DAILY_TREND_DAYS = 400;
const TREND_INDEX_VERSION = 2;

function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function parseLocalDate(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const [year, month, date] = day.split('-').map(Number);
    const parsed = new Date(year, month - 1, date);
    return !Number.isNaN(parsed.getTime())
        && parsed.getFullYear() === year
        && parsed.getMonth() === month - 1
        && parsed.getDate() === date
        ? parsed
        : null;
}

function toFiniteNumber(value) {
    if (value === null || value === undefined || value === '' || value === '--') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function createPluginSnapshot(plugins, trackedContentIds) {
    const trackedIds = new Set([...trackedContentIds].map(String));
    const snapshot = {};

    for (const plugin of plugins ?? []) {
        const contentId = String(plugin.contentId ?? '');
        if (!trackedIds.has(contentId)) continue;

        snapshot[contentId] = {
            name: plugin.name || contentId,
            users: toFiniteNumber(plugin.DoDCount),
            likes: toFiniteNumber(plugin.DoDLikes),
            saves: plugin.saveSource === 'figma-browser' ? toFiniteNumber(plugin.DoDSaves) : null
        };
    }

    return snapshot;
}

function loadDailyTrendIndex(indexPath) {
    const index = readJson(indexPath, null);
    return index
        && index.version === TREND_INDEX_VERSION
        && index.days
        && typeof index.days === 'object'
        ? index
        : { version: TREND_INDEX_VERSION, updatedAt: null, days: {} };
}

function storeDailyTrendIndex(indexPath, index) {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const temporaryPath = `${indexPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(index));
    fs.renameSync(temporaryPath, indexPath);
}

function updateDailyTrendSnapshot(indexPath, plugins, currentTime, trackedContentIds, options = {}) {
    const index = loadDailyTrendIndex(indexPath);
    const day = options.day ?? formatLocalDate(currentTime);
    const pluginsSnapshot = createPluginSnapshot(plugins, trackedContentIds);
    if (Object.keys(pluginsSnapshot).length === 0) return;

    index.days[day] = {
        capturedAt: currentTime.toISOString(),
        plugins: pluginsSnapshot
    };
    const retainedDays = Object.keys(index.days).sort().slice(-MAX_DAILY_TREND_DAYS);
    index.days = Object.fromEntries(retainedDays.map(retainedDay => [retainedDay, index.days[retainedDay]]));
    index.updatedAt = new Date().toISOString();
    index.version = TREND_INDEX_VERSION;
    storeDailyTrendIndex(indexPath, index);
}

function getDayDirectory(dataDirectory, day) {
    const [year, month, date] = day.split('-');
    return path.join(dataDirectory, year, month, date);
}

function listCollectionFiles(dataDirectory, day) {
    const dayDirectory = getDayDirectory(dataDirectory, day);
    if (!fs.existsSync(dayDirectory)) return [];
    return fs.readdirSync(dayDirectory)
        .filter(file => /^\d{2}-\d{2}\.json$/.test(file))
        .sort()
        .map(file => ({
            label: file.slice(0, -5).replace('-', ':'),
            filePath: path.join(dayDirectory, file)
        }));
}

function backfillDailyTrendIndex(indexPath, dataDirectory, days, trackedContentIds, now = new Date()) {
    const index = loadDailyTrendIndex(indexPath);
    let changed = false;

    for (let offset = 0; offset < days; offset++) {
        const date = new Date(now);
        date.setHours(12, 0, 0, 0);
        date.setDate(date.getDate() - offset);
        const day = formatLocalDate(date);
        if (index.days[day]) continue;

        const files = listCollectionFiles(dataDirectory, day);
        const latestFile = files.at(-1);
        if (!latestFile) continue;
        const plugins = readJson(latestFile.filePath, []);
        const pluginsSnapshot = createPluginSnapshot(plugins, trackedContentIds);
        if (Object.keys(pluginsSnapshot).length === 0) continue;

        index.days[day] = {
            capturedAt: `${day}T${latestFile.label === '24:00' ? '23:59' : latestFile.label}:00`,
            plugins: pluginsSnapshot
        };
        changed = true;
    }

    if (changed) {
        const retainedDays = Object.keys(index.days).sort().slice(-MAX_DAILY_TREND_DAYS);
        index.days = Object.fromEntries(retainedDays.map(day => [day, index.days[day]]));
        index.updatedAt = new Date().toISOString();
        index.version = TREND_INDEX_VERSION;
        storeDailyTrendIndex(indexPath, index);
    }
    return index;
}

function buildTrendResponse(points, metric, trackedContentIds) {
    if (!METRICS.has(metric)) throw new Error(`Unsupported metric: ${metric}`);
    const contentIds = [...trackedContentIds].map(String);
    const names = new Map();

    for (const point of points) {
        for (const [contentId, plugin] of Object.entries(point.plugins ?? {})) {
            if (plugin.name) names.set(contentId, plugin.name);
        }
    }

    return {
        labels: points.map(point => point.label),
        series: contentIds.map(contentId => ({
            contentId,
            name: names.get(contentId) ?? contentId,
            values: points.map(point => toFiniteNumber(point.plugins?.[contentId]?.[metric]))
        }))
    };
}

function getHourlyTrends(dataDirectory, day, metric, trackedContentIds) {
    if (!parseLocalDate(day)) throw new Error('Invalid day');
    const points = listCollectionFiles(dataDirectory, day).map(file => ({
        label: file.label,
        plugins: createPluginSnapshot(readJson(file.filePath, []), trackedContentIds)
    }));
    return buildTrendResponse(points, metric, trackedContentIds);
}

function getDailyTrends(indexPath, dataDirectory, days, metric, trackedContentIds, now = new Date()) {
    const safeDays = Math.max(1, Math.min(365, Number(days) || 30));
    const index = backfillDailyTrendIndex(indexPath, dataDirectory, safeDays, trackedContentIds, now);
    const points = [];

    for (let offset = safeDays - 1; offset >= 0; offset--) {
        const date = new Date(now);
        date.setHours(12, 0, 0, 0);
        date.setDate(date.getDate() - offset);
        const day = formatLocalDate(date);
        points.push({ label: day, plugins: index.days[day]?.plugins ?? {} });
    }

    return buildTrendResponse(points, metric, trackedContentIds);
}

module.exports = {
    buildTrendResponse,
    createPluginSnapshot,
    getDailyTrends,
    getHourlyTrends,
    loadDailyTrendIndex,
    updateDailyTrendSnapshot
};
