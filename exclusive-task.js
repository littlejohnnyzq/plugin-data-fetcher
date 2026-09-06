function createTaskInProgressError() {
    const error = new Error('Plugin data collection is already in progress');
    error.code = 'COLLECTION_IN_PROGRESS';
    return error;
}

function createExclusiveTask(task) {
    let activeRun = null;

    return async function runExclusiveTask(...args) {
        if (activeRun) {
            throw createTaskInProgressError();
        }

        const currentRun = Promise.resolve().then(() => task(...args));
        activeRun = currentRun;

        try {
            return await currentRun;
        } finally {
            if (activeRun === currentRun) {
                activeRun = null;
            }
        }
    };
}

module.exports = {
    createExclusiveTask,
    createTaskInProgressError
};
