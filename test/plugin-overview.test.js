const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
    buildPeriodPluginOverview,
    buildPluginOverview,
    findLatestCollection,
    resolveOverviewDateRange
} = require('../plugin-overview');

test('findLatestCollection uses the newest dated collection file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-overview-'));
    const oldDirectory = path.join(directory, '2026', '08', '31');
    const newDirectory = path.join(directory, '2026', '09', '01');
    fs.mkdirSync(oldDirectory, { recursive: true });
    fs.mkdirSync(newDirectory, { recursive: true });
    fs.writeFileSync(path.join(oldDirectory, '24-00.json'), '[]');
    fs.writeFileSync(path.join(newDirectory, '00-30.json'), JSON.stringify([{ contentId: 'new' }]));

    const collection = findLatestCollection(directory);
    assert.equal(collection.day, '2026-09-01');
    assert.equal(collection.time, '00:30');
    assert.equal(collection.plugins[0].contentId, 'new');
});

test('buildPluginOverview returns daily deltas and daily engagement rates', () => {
    const overview = buildPluginOverview({
        day: '2026-09-03',
        time: '10:30',
        plugins: [{
            contentId: '1370606842652257742',
            name: 'Owned',
            users: 200,
            DoDCount: 12,
            likes: 20,
            DoDLikes: 2,
            saves: 50,
            DoDSaves: 3,
            saveSource: 'figma-browser'
        }]
    }, new Set(['1370606842652257742']));

    assert.equal(overview.capturedAt, '2026-09-03 10:30');
    assert.deepEqual(overview.plugins[0], {
        contentId: '1370606842652257742',
        name: 'Owned',
        owned: true,
        users: 200,
        userDelta: 12,
        likes: 20,
        likeDelta: 2,
        likeRate: 2 / 12,
        saves: 50,
        saveDelta: 3,
        saveRate: 3 / 12,
        saveStatus: null,
        saveCollectedAt: null
    });
});

test('buildPeriodPluginOverview sums indexed daily values and calculates period rates', () => {
    const series = values => ({ series: [{ contentId: '1370606842652257742', name: 'Owned', values }] });
    const overview = buildPeriodPluginOverview({
        day: '2026-09-03',
        time: '10:30',
        plugins: [{
            contentId: '1370606842652257742',
            name: 'Owned',
            saveCollectedAt: '2026-09-03T02:00:00.000Z'
        }]
    }, new Set(['1370606842652257742']), {
        users: series([10, null, 20]),
        likes: series([1, 2, 3]),
        saves: series([null, 4, 5])
    }, { start: '2026-08-05', end: '2026-09-03', days: 30 });

    assert.equal(overview.days, 30);
    assert.equal(overview.start, '2026-08-05');
    assert.equal(overview.end, '2026-09-03');
    assert.deepEqual(overview.plugins[0], {
        contentId: '1370606842652257742',
        name: 'Owned',
        owned: true,
        userDelta: 30,
        likeDelta: 6,
        likeRate: 0.2,
        saveDelta: 9,
        saveRate: 0.3,
        saveStatus: null,
        saveCollectedAt: '2026-09-03T02:00:00.000Z'
    });
});

test('resolveOverviewDateRange validates an inclusive custom range', () => {
    const range = resolveOverviewDateRange('2026-08-05', '2026-09-03', '2026-09-04');
    assert.equal(range.start, '2026-08-05');
    assert.equal(range.end, '2026-09-03');
    assert.equal(range.days, 30);
    assert.equal(range.endDate.getFullYear(), 2026);
    assert.throws(
        () => resolveOverviewDateRange('2026-09-04', '2026-09-03', '2026-09-04'),
        /must not be after/
    );
});
