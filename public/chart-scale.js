(function exposeChartScale(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.ChartScale = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
    function niceStep(value) {
        if (!Number.isFinite(value) || value <= 0) return 1;
        const power = 10 ** Math.floor(Math.log10(value));
        const fraction = value / power;
        const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
        return niceFraction * power;
    }

    function createYAxisScale(values, targetIntervals = 4) {
        const finiteValues = values.filter(Number.isFinite);
        if (finiteValues.length === 0) {
            return { minimum: 0, maximum: 1, step: 1, ticks: [1, 0] };
        }

        const rawMinimum = Math.min(0, ...finiteValues);
        const rawMaximum = Math.max(0, ...finiteValues);
        const range = rawMaximum - rawMinimum || Math.max(1, Math.abs(rawMaximum));
        const step = niceStep(range / Math.max(1, targetIntervals));
        let minimum = Math.floor(rawMinimum / step) * step;
        let maximum = Math.ceil(rawMaximum / step) * step;
        if (minimum === maximum) maximum = minimum + step;

        const intervalCount = Math.round((maximum - minimum) / step);
        const ticks = Array.from(
            { length: intervalCount + 1 },
            (_, index) => Number((maximum - step * index).toPrecision(12))
        );
        return { minimum, maximum, step, ticks };
    }

    function formatAxisTick(value, step) {
        const absolute = Math.abs(value);
        const divisor = absolute >= 1000000 ? 1000000 : absolute >= 1000 ? 1000 : 1;
        const suffix = divisor === 1000000 ? 'M' : divisor === 1000 ? 'K' : '';
        const scaledValue = value / divisor;
        const scaledStep = step / divisor;
        const fractionDigits = scaledStep >= 1
            ? 0
            : Math.min(4, Math.max(0, Math.ceil(-Math.log10(scaledStep))));
        return `${scaledValue.toLocaleString('zh-CN', {
            minimumFractionDigits: 0,
            maximumFractionDigits: fractionDigits
        })}${suffix}`;
    }

    return { createYAxisScale, formatAxisTick, niceStep };
}));
