import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareCoverage, coverageComparisonExport } from '../src/lib/coverageComparison';
import { coverageDifferenceColor, coverageDifferenceRaster } from '../src/lib/coverageDifference';
import type { RadioMapGrid } from '../src/types';

function grid(values: (number | null)[]): RadioMapGrid {
  return {
    cells: values.map((value, x) => ({
      x, y: 0, z: 1.5, powerDbm: value ?? -250, servingTx: value === null ? null : 0, isLos: false,
    })),
    minX: 0, maxX: 3, minY: 0, maxY: 1, gridSize: 1, heightOffset: 1.5,
    metric: 'power', solverMethod: 'radio_map', samplesPerTx: 1000, seed: 42,
  };
}

test('comparison shares a finite range and a served threshold, preserving actual cell values', () => {
  const baseline = { grid: grid([-220, -100, null]), provenance: { id: 'A' } };
  const current = { grid: grid([-210, -80, -70]), provenance: { id: 'B' } };
  const comparison = compareCoverage(baseline.grid, current.grid, -90);
  assert.ok(comparison);
  assert.deepEqual(comparison.range, { min: -220, max: -70 });
  assert.equal(comparison.baseline.p5, -214);
  assert.equal(comparison.current.p5, -197);
  assert.equal(comparison.baseline.servedPercent, 0);
  assert.equal(comparison.current.servedPercent, 200 / 3);
  const exported = coverageComparisonExport(baseline, current, comparison, 'viridis');
  assert.deepEqual(exported.baseline.provenance, { id: 'A' });
  assert.deepEqual(exported.baseline.raster.cells, baseline.grid.cells);
  assert.deepEqual(exported.differences.cells.map(cell => cell.deltaDb), [10, 20, null]);
});

test('comparison requires the same raster positions and selected metric', () => {
  const baseline = grid([-100, -80]);
  const current = grid([-90, -70]);
  assert.equal(compareCoverage(baseline, { ...current, metric: 'sinr' }, 0), null);
  current.cells[1].z = 5;
  assert.equal(compareCoverage(baseline, current, -90), null);
});

test('served rate counts sampled cells with no path and excludes masked cells', () => {
  const values = [-70, ...Array<number | null>(100).fill(null)];
  const baseline = grid(values);
  const current = grid(values);
  baseline.cells[100].sampled = current.cells[100].sampled = false;
  const comparison = compareCoverage(baseline, current, -90);
  assert.ok(comparison);
  assert.deepEqual(comparison.current, { sampledCells: 100, finiteCells: 1, p5: -70, servedPercent: 1 });
});

test('difference raster uses north-up rows and a symmetric diverging scale', () => {
  const baseline = grid([-100, -100, -100, -100, -100, null]);
  const current = grid([-110, -90, -100, -80, -103, -70]);
  for (const item of [baseline, current]) {
    item.cells.forEach((cell, index) => {
      cell.x = index % 3;
      cell.y = Math.floor(index / 3);
    });
  }
  const raster = coverageDifferenceRaster(baseline, current, 'power');
  assert.equal(raster.columns, 3);
  assert.equal(raster.rows, 2);
  assert.equal(raster.maxAbsDb, 20);
  assert.deepEqual(raster.northUpDeltas, [20, -3, null, -10, 10, 0]);
  assert.deepEqual(coverageDifferenceColor(0, raster.maxAbsDb), [247, 247, 247]);
  assert.ok(coverageDifferenceColor(-10, raster.maxAbsDb)[0] < coverageDifferenceColor(-10, raster.maxAbsDb)[2]);
  assert.ok(coverageDifferenceColor(10, raster.maxAbsDb)[0] > coverageDifferenceColor(10, raster.maxAbsDb)[2]);
});
