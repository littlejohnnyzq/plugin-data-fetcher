const assert = require('node:assert/strict');
const test = require('node:test');
const {
    addMandatoryPluginsToWatchlist,
    buildWatchlist,
    collectSaveCounts,
    extractSaveCount,
    fetchSaveCountFromFigStats,
    mapWithConcurrency
} = require('../save-tracker');

test('buildWatchlist selects the top half by previous-day user growth', () => {
    const watchlist = buildWatchlist([
        { id: 'a', contentId: '1', name: 'A', users: 100, DoDCount: 8 },
        { id: 'b', contentId: '2', name: 'B', users: 300, DoDCount: 3 },
        { id: 'c', contentId: '3', name: 'C', users: 200, DoDCount: 8 },
        { id: 'd', contentId: '4', name: 'D', users: 400, DoDCount: '--' },
        { id: 'e', contentId: '5', name: 'E', users: 500, DoDCount: 1 }
    ], '2026-08-25');

    assert.equal(watchlist.watchedCount, 3);
    assert.deepEqual(watchlist.plugins.map(plugin => plugin.id), ['c', 'a', 'b']);
    assert.equal(watchlist.sourceDate, '2026-08-25');
});

test('buildWatchlist unions top growth, high-user and fixed-plugin rules', () => {
    const watchlist = buildWatchlist([
        { id: 'growth', contentId: '1', name: 'Growth', users: 100, DoDCount: 10 },
        { id: 'ordinary', contentId: '2', name: 'Ordinary', users: 100, DoDCount: 9 },
        { id: 'high-users', contentId: '3', name: 'High users', users: 50001, DoDCount: 1 },
        { id: 'fixed', contentId: '1473659572195493091', name: 'Fixed', users: 10, DoDCount: 0 }
    ], '2026-08-25');

    assert.equal(watchlist.topGrowthCount, 2);
    assert.deepEqual(watchlist.plugins.map(plugin => plugin.id), ['growth', 'ordinary', 'high-users', 'fixed']);
    assert.deepEqual(
        watchlist.plugins.find(plugin => plugin.id === 'high-users').watchReasons,
        ['users-over-50000']
    );
    assert.deepEqual(
        watchlist.plugins.find(plugin => plugin.id === 'fixed').watchReasons,
        ['fixed-plugin']
    );
});

test('mandatory rules are added to an existing watchlist immediately', () => {
    const watchlist = {
        totalPlugins: 3,
        watchedCount: 1,
        plugins: [{ id: 'growth', contentId: '1', name: 'Growth', watchReasons: ['top-growth-50-percent'] }]
    };
    const changed = addMandatoryPluginsToWatchlist(watchlist, [
        { id: 'growth', contentId: '1', name: 'Growth', users: 10 },
        { id: 'high-users', contentId: '2', name: 'High users', users: 50001 },
        { id: 'fixed', contentId: '1370606842652257742', name: 'Fixed', users: 10 }
    ]);

    assert.equal(changed, true);
    assert.equal(watchlist.watchedCount, 3);
    assert.deepEqual(watchlist.plugins.map(plugin => plugin.id), ['growth', 'high-users', 'fixed']);
});

test('fetchSaveCountFromFigStats maps installs to Saves', async () => {
    const saves = await fetchSaveCountFromFigStats('123', {
        request: async url => {
            assert.equal(url, 'https://api.fig-stats.com/plugins/123');
            return { data: { installs: 456 } };
        }
    });

    assert.equal(saves, 456);
});

test('extractSaveCount reads UseAction from Figma JSON-LD', () => {
    const html = `<!doctype html><script type="application/ld+json">${JSON.stringify({
        '@graph': [{
            interactionStatistic: [
                { interactionType: 'https://schema.org/LikeAction', userInteractionCount: 12 },
                { interactionType: 'https://schema.org/UseAction', userInteractionCount: 34 }
            ]
        }]
    })}</script>`;

    assert.equal(extractSaveCount(html), 34);
    assert.equal(extractSaveCount('<html></html>'), null);
});

test('collectSaveCounts only requests watched plugins and calculates daily growth', async () => {
    const plugins = [
        { id: 'watched', contentId: '101', name: 'Watched' },
        { id: 'ignored', contentId: '102', name: 'Ignored' }
    ];
    const requestedContentIds = [];

    await collectSaveCounts(
        plugins,
        { plugins: [{ id: 'watched' }] },
        [{ id: 'watched', saves: 30 }],
        {
            fetchSaveCount: async contentId => {
                requestedContentIds.push(contentId);
                return 37;
            }
        }
    );

    assert.deepEqual(requestedContentIds, ['101']);
    assert.deepEqual(
        plugins.map(plugin => ({ id: plugin.id, tracked: plugin.isSaveTracked, saves: plugin.saves, growth: plugin.DoDSaves })),
        [
            { id: 'watched', tracked: true, saves: 37, growth: 7 },
            { id: 'ignored', tracked: false, saves: null, growth: '--' }
        ]
    );
});

test('fixed realtime plugins use the Figma fetcher while other plugins use daily stats', async () => {
    const plugins = [
        { id: 'realtime', contentId: '731451122947612104', name: 'Realtime' },
        { id: 'daily', contentId: '200', name: 'Daily' }
    ];
    const calls = [];

    await collectSaveCounts(
        plugins,
        { plugins: plugins.map(plugin => ({ id: plugin.id })) },
        [],
        {
            realtimeDelayMs: 0,
            fetchRealtimeSaveCount: async contentId => {
                calls.push(`figma:${contentId}`);
                return 10;
            },
            fetchDailySaveCount: async contentId => {
                calls.push(`fig-stats:${contentId}`);
                return 20;
            }
        }
    );

    assert.deepEqual(calls.sort(), ['fig-stats:200', 'figma:731451122947612104']);
    assert.equal(plugins[0].saveSource, 'figma-live');
    assert.equal(plugins[1].saveSource, 'fig-stats-daily');
});

test('mapWithConcurrency respects its concurrency limit', async () => {
    let activeWorkers = 0;
    let maximumWorkers = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async value => {
        activeWorkers++;
        maximumWorkers = Math.max(maximumWorkers, activeWorkers);
        await new Promise(resolve => setTimeout(resolve, 5));
        activeWorkers--;
        return value * 2;
    });

    assert.deepEqual(results, [2, 4, 6, 8, 10]);
    assert.equal(maximumWorkers, 2);
});
