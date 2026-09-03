const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { buildPluginOverview, findLatestCollection } = require('../plugin-overview');

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

test('buildPluginOverview returns daily deltas and total engagement rates', () => {
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
        likeRate: 0.1,
        saves: 50,
        saveDelta: 3,
        saveRate: 0.25,
        saveStatus: null,
        saveCollectedAt: null
    });
});
