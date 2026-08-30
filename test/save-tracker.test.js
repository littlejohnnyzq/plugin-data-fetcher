const assert = require('node:assert/strict');
const test = require('node:test');
const {
    ALWAYS_WATCHED_CONTENT_IDS,
    REALTIME_SAVE_CONTENT_IDS,
    addMandatoryPluginsToWatchlist,
    buildWatchlist,
    collectSaveCounts,
    extractSaveCount,
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

test('Print for Figma is always included in realtime Save collection', () => {
    assert.equal(ALWAYS_WATCHED_CONTENT_IDS.has('874441781480244375'), true);
    assert.equal(REALTIME_SAVE_CONTENT_IDS.has('874441781480244375'), true);
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

test('collectSaveCounts only requests watched browser plugins and calculates growth from browser data', async () => {
    const plugins = [
        { id: 'watched', contentId: '731451122947612104', name: 'Watched' },
        { id: 'ignored', contentId: '102', name: 'Ignored' }
    ];
    const requestedContentIds = [];

    await collectSaveCounts(
        plugins,
        { plugins: [{ id: 'watched' }] },
        [{ id: 'watched', saves: 30, saveSource: 'figma-browser' }],
        {
            realtimeDelayMs: 0,
            fetchRealtimeSaveCount: async contentId => {
                requestedContentIds.push(contentId);
                return 37;
            }
        }
    );

    assert.deepEqual(requestedContentIds, ['731451122947612104']);
    assert.deepEqual(
        plugins.map(plugin => ({ id: plugin.id, tracked: plugin.isSaveTracked, saves: plugin.saves, growth: plugin.DoDSaves })),
        [
            { id: 'watched', tracked: true, saves: 37, growth: 7 },
            { id: 'ignored', tracked: false, saves: null, growth: '--' }
        ]
    );
});

test('non-browser plugins do not use FigStats or another Save fetcher', async () => {
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
            realtimeRotationOffset: 0,
            fetchRealtimeSaveCount: async contentId => {
                calls.push(`figma:${contentId}`);
                return 10;
            }
        }
    );

    assert.deepEqual(calls, ['figma:731451122947612104']);
    assert.equal(plugins[0].saveSource, 'figma-browser');
    assert.equal(plugins[1].saves, null);
    assert.equal(plugins[1].saveSource, null);
});

test('realtime collection cools down and retries once after a Figma WAF challenge', async () => {
    const plugin = { id: 'realtime', contentId: '731451122947612104', name: 'Realtime' };
    let attempts = 0;

    await collectSaveCounts(
        [plugin],
        { plugins: [{ id: plugin.id }] },
        [],
        {
            realtimeDelayMs: 0,
            wafCooldownMs: 0,
            retryRealtimeWaf: true,
            realtimeRotationOffset: 0,
            fetchRealtimeSaveCount: async () => {
                attempts++;
                if (attempts === 1) {
                    const error = new Error('Figma WAF challenge');
                    error.code = 'FIGMA_WAF_CHALLENGE';
                    throw error;
                }
                return 42;
            }
        }
    );

    assert.equal(attempts, 2);
    assert.equal(plugin.saves, 42);
    assert.equal(plugin.saveStatus, 'ok');
    assert.equal(plugin.saveError, null);
});

test('failed browser collection carries forward browser values and ignores FigStats values', async () => {
    const browserPlugin = { id: 'browser', contentId: '731451122947612104', name: 'Browser' };
    const dailyPlugin = { id: 'daily', contentId: '200', name: 'Daily' };

    await collectSaveCounts(
        [browserPlugin, dailyPlugin],
        { plugins: [{ id: 'browser' }, { id: 'daily' }] },
        [
            { id: 'browser', saves: 40, saveSource: 'figma-browser' },
            { id: 'daily', saves: 15, saveSource: 'fig-stats-daily' }
        ],
        {
            lastSaveData: [
                { id: 'browser', saves: 42, saveSource: 'figma-browser', saveCollectedAt: '2026-08-27T00:00:00.000Z' },
                { id: 'daily', saves: 20, saveSource: 'fig-stats-daily', saveCollectedAt: '2026-08-27T00:00:00.000Z' }
            ],
            realtimeDelayMs: 0,
            realtimeRotationOffset: 0,
            fetchRealtimeSaveCount: async () => {
                throw new Error('browser unavailable');
            }
        }
    );

    assert.deepEqual(
        [browserPlugin, dailyPlugin].map(plugin => ({
            id: plugin.id,
            saves: plugin.saves,
            growth: plugin.DoDSaves,
            status: plugin.saveStatus,
            source: plugin.saveSource
        })),
        [
            { id: 'browser', saves: 42, growth: 2, status: 'stale', source: 'figma-browser' },
            { id: 'daily', saves: null, growth: '--', status: 'pending', source: null }
        ]
    );
});

test('browser Save collection stops the run after a WAF challenge', async () => {
    const plugins = [
        { id: 'one', contentId: '731451122947612104', name: 'One' },
        { id: 'two', contentId: '1404821057322599271', name: 'Two' }
    ];
    let attempts = 0;

    await collectSaveCounts(
        plugins,
        { plugins: plugins.map(plugin => ({ id: plugin.id })) },
        [],
        {
            lastSaveData: plugins.map((plugin, index) => ({
                id: plugin.id,
                saves: 10 + index,
                saveSource: 'figma-browser'
            })),
            realtimeRotationOffset: 0,
            realtimeDelayMs: 0,
            fetchRealtimeSaveCount: async () => {
                attempts++;
                const error = new Error('Figma WAF challenge');
                error.code = 'FIGMA_WAF_CHALLENGE';
                throw error;
            }
        }
    );

    assert.equal(attempts, 1);
    assert.deepEqual(plugins.map(plugin => plugin.saves), [10, 11]);
    assert.deepEqual(plugins.map(plugin => plugin.saveStatus), ['stale', 'carried-forward']);
});

test('browser Save collection only processes the selected half-hour batch', async () => {
    const plugins = [
        { id: 'one', contentId: '731451122947612104', name: 'One' },
        { id: 'two', contentId: '1404821057322599271', name: 'Two' },
        { id: 'three', contentId: '1249759048471403961', name: 'Three' }
    ];
    const requested = [];

    await collectSaveCounts(
        plugins,
        { plugins: plugins.map(plugin => ({ id: plugin.id })) },
        [],
        {
            realtimeContentIds: ['1404821057322599271'],
            realtimeDelayMs: 0,
            fetchRealtimeSaveCount: async contentId => {
                requested.push(contentId);
                return 22;
            }
        }
    );

    assert.deepEqual(requested, ['1404821057322599271']);
    assert.deepEqual(plugins.map(plugin => plugin.saveStatus), ['pending', 'ok', 'pending']);
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
