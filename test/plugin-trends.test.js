const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
    getDailyTrends,
    getHourlyTrends,
    loadDailyTrendIndex,
    updateDailyTrendSnapshot
} = require('../plugin-trends');

const TRACKED_IDS = new Set(['101', '102']);

function plugin(contentId, values = {}) {
    return {
        id: `id-${contentId}`,
        contentId,
        name: `Plugin ${contentId}`,
        users: 100,
        likes: 20,
        saves: 30,
        DoDCount: values.users ?? 10,
        DoDLikes: values.likes ?? 2,
        DoDSaves: values.saves ?? 3,
        saveSource: values.saveSource ?? 'figma-browser'
    };
}

test('daily trend snapshots keep only tracked plugins and browser Save values', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-trends-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const indexPath = path.join(directory, 'daily.json');

    updateDailyTrendSnapshot(indexPath, [
        plugin('101', { saves: 9 }),
        plugin('102', { saves: 20, saveSource: 'fig-stats-daily' }),
        plugin('ignored', { saves: 99 })
    ], new Date('2026-08-27T12:30:00+08:00'), TRACKED_IDS);

    const snapshot = loadDailyTrendIndex(indexPath).days['2026-08-27'].plugins;
    assert.deepEqual(Object.keys(snapshot), ['101', '102']);
    assert.equal(snapshot['101'].saves, 9);
    assert.equal(snapshot['102'].saves, null);
});

test('hourly trends read only the selected day collection files', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-trends-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const dayDirectory = path.join(directory, '2026', '08', '27');
    fs.mkdirSync(dayDirectory, { recursive: true });
    fs.writeFileSync(path.join(dayDirectory, '00-00.json'), JSON.stringify([plugin('101', { users: 10 })]));
    fs.writeFileSync(path.join(dayDirectory, '00-30.json'), JSON.stringify([plugin('101', { users: 12 })]));

    const trends = getHourlyTrends(directory, '2026-08-27', 'users', TRACKED_IDS);

    assert.deepEqual(trends.labels, ['00:00', '00:30']);
    assert.deepEqual(trends.series[0].values, [10, 12]);
    assert.deepEqual(trends.series[1].values, [null, null]);
});

test('daily trends backfill from only the latest file of each day', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-trends-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const dataDirectory = path.join(directory, 'data');
    const indexPath = path.join(directory, 'daily.json');
    const dayDirectory = path.join(dataDirectory, '2026', '08', '26');
    fs.mkdirSync(dayDirectory, { recursive: true });
    fs.writeFileSync(path.join(dayDirectory, '10-00.json'), JSON.stringify([plugin('101', { likes: 4 })]));
    fs.writeFileSync(path.join(dayDirectory, '23-30.json'), JSON.stringify([plugin('101', { likes: 7 })]));

    const trends = getDailyTrends(
        indexPath,
        dataDirectory,
        2,
        'likes',
        TRACKED_IDS,
        new Date('2026-08-27T12:00:00+08:00')
    );

    assert.deepEqual(trends.labels, ['2026-08-26', '2026-08-27']);
    assert.deepEqual(trends.series[0].values, [7, null]);
    assert.equal(loadDailyTrendIndex(indexPath).days['2026-08-26'].plugins['101'].likes, 7);
});
