const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

function millisecondsUntilNextBoundary(nowMs, intervalMs = DEFAULT_INTERVAL_MS) {
    const remainder = ((nowMs % intervalMs) + intervalMs) % intervalMs;
    return remainder === 0 ? intervalMs : intervalMs - remainder;
}

function scheduleAlignedTask(task, options = {}) {
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const now = options.now ?? Date.now;
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;
    const onError = options.onError ?? (error => console.error('Scheduled task failed:', error));
    let timer = null;
    let stopped = false;

    function scheduleNext() {
        if (stopped) {
            return;
        }

        const currentTimeMs = now();
        const delay = millisecondsUntilNextBoundary(currentTimeMs, intervalMs);
        const boundaryTimeMs = currentTimeMs + delay;
        timer = setTimer(() => runTask(boundaryTimeMs), delay);
    }

    function runTask(boundaryTimeMs) {
        if (stopped) {
            return;
        }

        // A timer can occasionally wake just before the wall-clock boundary.
        // Wait out the remaining milliseconds instead of scheduling a second run.
        const remainingMs = boundaryTimeMs - now();
        if (remainingMs > 0) {
            timer = setTimer(() => runTask(boundaryTimeMs), remainingMs);
            return;
        }

        // Schedule from the wall clock before starting work, so task duration
        // never shifts the following :00/:30 run.
        scheduleNext();
        Promise.resolve()
            .then(() => task(boundaryTimeMs))
            .catch(onError);
    }

    scheduleNext();

    return () => {
        stopped = true;
        if (timer !== null) {
            clearTimer(timer);
        }
    };
}

module.exports = {
    DEFAULT_INTERVAL_MS,
    millisecondsUntilNextBoundary,
    scheduleAlignedTask
};
