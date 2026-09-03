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
        return [{
            contentId,
            name: plugin.name || contentId,
            owned: OWNED_PLUGIN_CONTENT_IDS.has(contentId),
            users,
            userDelta: toFiniteNumber(plugin.DoDCount),
            likes,
            likeDelta: toFiniteNumber(plugin.DoDLikes),
            likeRate: calculateRate(likes, users),
            saves,
            saveDelta: plugin.saveSource === 'figma-browser' ? toFiniteNumber(plugin.DoDSaves) : null,
            saveRate: calculateRate(saves, users),
            saveStatus: plugin.saveStatus ?? null,
            saveCollectedAt: plugin.saveCollectedAt ?? null
        }];
    });

    return {
        capturedAt: `${collection.day} ${collection.time}`,
        plugins
    };
}

module.exports = {
    OWNED_PLUGIN_CONTENT_IDS,
    buildPluginOverview,
    calculateRate,
    findLatestCollection
};
