const fs = require('fs');
const path = require('path');

const OWNED_PLUGIN_CONTENT_IDS = new Set([
    '1370606842652257742',
    '1387823712562916211',
    '1414925802794094447',
    '1473659572195493091'
]);

function toFiniteNumber(value) {
    if (value === null || value === undefined || value === '' || value === '--') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function listDirectories(directory, pattern) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && pattern.test(entry.name))
        .map(entry => entry.name)
        .sort()
        .reverse();
}

function findLatestCollection(dataDirectory) {
    for (const year of listDirectories(dataDirectory, /^\d{4}$/)) {
        const yearDirectory = path.join(dataDirectory, year);
        for (const month of listDirectories(yearDirectory, /^\d{2}$/)) {
            const monthDirectory = path.join(yearDirectory, month);
            for (const day of listDirectories(monthDirectory, /^\d{2}$/)) {
                const dayDirectory = path.join(monthDirectory, day);
                const file = fs.readdirSync(dayDirectory)
                    .filter(name => /^\d{2}-\d{2}\.json$/.test(name))
                    .sort()
                    .at(-1);
                if (!file) continue;

                const plugins = JSON.parse(fs.readFileSync(path.join(dayDirectory, file), 'utf8'));
                return {
                    day: `${year}-${month}-${day}`,
                    time: file.slice(0, -5).replace('-', ':'),
                    plugins: Array.isArray(plugins) ? plugins : []
                };
            }
        }
    }
    return null;
}

function calculateRate(value, users) {
    return value === null || users === null || users <= 0 ? null : value / users;
}

function parseLocalDay(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const [year, month, date] = day.split('-').map(Number);
    const parsed = new Date(year, month - 1, date, 12, 0, 0, 0);
    return parsed.getFullYear() === year
        && parsed.getMonth() === month - 1
        && parsed.getDate() === date
        ? parsed
        : null;
}

function resolveOverviewDateRange(start, end, fallbackDay, maximumDays = 365) {
    const startDay = start || fallbackDay;
    const endDay = end || fallbackDay;
    const startDate = parseLocalDay(startDay);
    const endDate = parseLocalDay(endDay);
    if (!startDate || !endDate) throw new Error('Invalid overview date range');

    const [startYear, startMonth, startDateNumber] = startDay.split('-').map(Number);
    const [endYear, endMonth, endDateNumber] = endDay.split('-').map(Number);
    const dayDifference = Math.round(
        (Date.UTC(endYear, endMonth - 1, endDateNumber) - Date.UTC(startYear, startMonth - 1, startDateNumber))
        / (24 * 60 * 60 * 1000)
    );
    if (dayDifference < 0) throw new Error('Overview start date must not be after end date');
    const days = dayDifference + 1;
    if (days > maximumDays) throw new Error(`Overview date range cannot exceed ${maximumDays} days`);

    return { start: startDay, end: endDay, days, endDate };
}

function buildPluginOverview(collection, trackedContentIds) {
    if (!collection) return { capturedAt: null, plugins: [] };
    const pluginByContentId = new Map(
        collection.plugins.map(plugin => [String(plugin.contentId ?? ''), plugin])
    );
    const plugins = [...trackedContentIds].map(String).flatMap(contentId => {
        const plugin = pluginByContentId.get(contentId);
        if (!plugin) return [];
        const users = toFiniteNumber(plugin.users);
        const likes = toFiniteNumber(plugin.likes);
        const saves = toFiniteNumber(plugin.saves);
        const userDelta = toFiniteNumber(plugin.DoDCount);
        const likeDelta = toFiniteNumber(plugin.DoDLikes);
        const saveDelta = plugin.saveSource === 'figma-browser' ? toFiniteNumber(plugin.DoDSaves) : null;
        return [{
            contentId,
            name: plugin.name || contentId,
            owned: OWNED_PLUGIN_CONTENT_IDS.has(contentId),
            users,
            userDelta,
            likes,
            likeDelta,
            likeRate: calculateRate(likeDelta, userDelta),
            saves,
            saveDelta,
            saveRate: calculateRate(saveDelta, userDelta),
            saveStatus: plugin.saveStatus ?? null,
            saveCollectedAt: plugin.saveCollectedAt ?? null
        }];
    });

    return {
        capturedAt: `${collection.day} ${collection.time}`,
        plugins
    };
}

function sumTrendValues(trends, contentId) {
    const series = trends?.series?.find(item => String(item.contentId) === contentId);
    const values = (series?.values ?? []).filter(Number.isFinite);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

function buildPeriodPluginOverview(collection, trackedContentIds, trendsByMetric, dateRange) {
    if (!collection) return { capturedAt: null, ...dateRange, plugins: [] };
    const latestByContentId = new Map(
        collection.plugins.map(plugin => [String(plugin.contentId ?? ''), plugin])
    );
    const plugins = [...trackedContentIds].map(String).map(contentId => {
        const latest = latestByContentId.get(contentId) ?? {};
        const userDelta = sumTrendValues(trendsByMetric.users, contentId);
        const likeDelta = sumTrendValues(trendsByMetric.likes, contentId);
        const saveDelta = sumTrendValues(trendsByMetric.saves, contentId);
        return {
            contentId,
            name: latest.name || trendsByMetric.users?.series?.find(item => String(item.contentId) === contentId)?.name || contentId,
            owned: OWNED_PLUGIN_CONTENT_IDS.has(contentId),
            userDelta,
            likeDelta,
            likeRate: calculateRate(likeDelta, userDelta),
            saveDelta,
            saveRate: calculateRate(saveDelta, userDelta),
            saveStatus: latest.saveStatus ?? null,
            saveCollectedAt: latest.saveCollectedAt ?? null
        };
    });

    return {
        capturedAt: `${collection.day} ${collection.time}`,
        ...dateRange,
        plugins
    };
}

module.exports = {
    OWNED_PLUGIN_CONTENT_IDS,
    buildPeriodPluginOverview,
    buildPluginOverview,
    calculateRate,
    findLatestCollection,
    resolveOverviewDateRange
};
