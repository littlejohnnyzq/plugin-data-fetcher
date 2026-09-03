const assert = require('node:assert/strict');
const test = require('node:test');
const { createYAxisScale, formatAxisTick } = require('../public/chart-scale');

test('small integer chart values use unique aligned axis ticks', () => {
    const scale = createYAxisScale([0, 1, 2, 3]);
    assert.deepEqual(scale.ticks, [3, 2, 1, 0]);
    assert.equal(new Set(scale.ticks.map(value => formatAxisTick(value, scale.step))).size, scale.ticks.length);
});

test('fractional values retain distinct fractional labels', () => {
    const scale = createYAxisScale([0.1, 0.7]);
    const labels = scale.ticks.map(value => formatAxisTick(value, scale.step));
    assert.equal(new Set(labels).size, labels.length);
    assert.equal(scale.minimum <= 0.1, true);
    assert.equal(scale.maximum >= 0.7, true);
});
