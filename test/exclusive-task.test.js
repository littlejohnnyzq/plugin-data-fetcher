const assert = require('node:assert/strict');
const test = require('node:test');
const { createExclusiveTask } = require('../exclusive-task');

test('exclusive task rejects an overlapping run and allows the next run after completion', async () => {
    let releaseFirstRun;
    const firstRunGate = new Promise(resolve => {
        releaseFirstRun = resolve;
    });
    let runCount = 0;
    const task = createExclusiveTask(async value => {
        runCount++;
        if (value === 'first') await firstRunGate;
        return value;
    });

    const firstRun = task('first');
    await assert.rejects(task('overlap'), error => error.code === 'COLLECTION_IN_PROGRESS');
    assert.equal(runCount, 1);

    releaseFirstRun();
    assert.equal(await firstRun, 'first');
    assert.equal(await task('next'), 'next');
    assert.equal(runCount, 2);
});

test('exclusive task unlocks after a failed run', async () => {
    let shouldFail = true;
    const task = createExclusiveTask(async () => {
        if (shouldFail) throw new Error('failed');
        return 'recovered';
    });

    await assert.rejects(task(), /failed/);
    shouldFail = false;
    assert.equal(await task(), 'recovered');
});
