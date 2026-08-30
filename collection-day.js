function shiftLocalDays(date, days) {
    const shifted = new Date(date);
    shifted.setDate(shifted.getDate() + days);
    return shifted;
}

function createCollectionDayPlan(collectionTime) {
    const isMidnight = collectionTime.getHours() === 0 && collectionTime.getMinutes() === 0;
    return {
        isMidnight,
        completedDay: isMidnight ? shiftLocalDays(collectionTime, -1) : null,
        comparisonDay: shiftLocalDays(collectionTime, isMidnight ? -2 : -1)
    };
}

function resetDailyGrowth(plugins) {
    return (plugins ?? []).map(plugin => ({
        ...plugin,
        DoDCount: 0,
        DoDLikes: 0,
        DoDSaves: plugin.saves !== null
            && plugin.saves !== undefined
            && plugin.saves !== ''
            && plugin.saves !== '--'
            && Number.isFinite(Number(plugin.saves))
            ? 0
            : plugin.DoDSaves
    }));
}

module.exports = {
    createCollectionDayPlan,
    resetDailyGrowth,
    shiftLocalDays
};
