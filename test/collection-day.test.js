const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createCollectionDayPlan,
    resetDailyGrowth
} = require('../collection-day');

test('midnight belongs to the completed day and compares against the day before it', () => {
    const collectionTime = new Date(2026, 7, 30, 0, 0, 0, 0);
    const plan = createCollectionDayPlan(collectionTime);

    assert.equal(plan.isMidnight, true);
    assert.equal(plan.completedDay.getFullYear(), 2026);
    assert.equal(plan.completedDay.getMonth(), 7);
    assert.equal(plan.completedDay.getDate(), 29);
    assert.equal(plan.comparisonDay.getDate(), 28);
});

test('ordinary collection compares against the previous completed day', () => {
    const collectionTime = new Date(2026, 7, 30, 12, 30, 0, 0);
    const plan = createCollectionDayPlan(collectionTime);

    assert.equal(plan.isMidnight, false);
    assert.equal(plan.completedDay, null);
    assert.equal(plan.comparisonDay.getDate(), 29);
});

test('00:00 snapshot resets available daily growth without inventing Save data', () => {
    const source = [
        { id: 'tracked', users: 100, likes: 20, saves: 30, DoDCount: 8, DoDLikes: 2, DoDSaves: 3 },
        { id: 'untracked', users: 50, likes: 10, saves: null, DoDCount: 4, DoDLikes: 1, DoDSaves: '--' }
    ];
    const snapshot = resetDailyGrowth(source);

    assert.deepEqual(
        snapshot.map(plugin => [plugin.DoDCount, plugin.DoDLikes, plugin.DoDSaves]),
        [[0, 0, 0], [0, 0, '--']]
    );
    assert.equal(source[0].DoDCount, 8);
});
