const test = require('node:test');
const assert = require('node:assert/strict');
const {
    millisecondsUntilNextBoundary,
    scheduleAlignedTask
} = require('../aligned-scheduler');

test('calculates the next half-hour boundary from the wall clock', () => {
    const halfHour = 30 * 60 * 1000;

    assert.equal(millisecondsUntilNextBoundary(0, halfHour), halfHour);
    assert.equal(millisecondsUntilNextBoundary(10 * 60 * 1000, halfHour), 20 * 60 * 1000);
    assert.equal(millisecondsUntilNextBoundary(29 * 60 * 1000 + 59_000, halfHour), 1_000);
});

test('schedules the next boundary before waiting for the current task', async () => {
    const halfHour = 30 * 60 * 1000;
    let currentTime = 10 * 60 * 1000;
    const timers = [];
    let resolveTask;
    const unfinishedTask = new Promise(resolve => {
        resolveTask = resolve;
    });

    scheduleAlignedTask(() => unfinishedTask, {
        intervalMs: halfHour,
        now: () => currentTime,
        setTimer: (callback, delay) => {
            timers.push({ callback, delay });
            return timers.length;
        },
        clearTimer: () => {}
    });

    assert.equal(timers[0].delay, 20 * 60 * 1000);

    currentTime = halfHour;
    timers[0].callback();

    assert.equal(timers.length, 2);
    assert.equal(timers[1].delay, halfHour);

    resolveTask();
    await unfinishedTask;
});
