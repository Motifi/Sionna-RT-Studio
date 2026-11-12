import assert from 'node:assert/strict';
import { test } from 'node:test';
import { starterExperiment } from '../src/lib/experimentPresets';
import { sampleTrajectory, trajectorySampling } from '../src/lib/trajectory';

test('starter static preset has one isotropic link and a known absolute direct-path delay', () => {
  const setup = starterExperiment('static');
  assert.deepEqual(setup.tx.antennaArraySize, [1, 1]);
  assert.deepEqual(setup.rx.antennaArraySize, [1, 1]);
  assert.equal(setup.tx.height, setup.rx.height);
  const distance = setup.rx.enu.x - setup.tx.enu.x;
  assert.equal(distance, 65);
  assert.ok(Math.abs(distance / 299_792_458 * 1e9 - 216.82) < 0.01);
  assert.equal(setup.options.txPattern, 'iso');
  assert.equal(setup.maxDepth, 0);
  assert.equal(setup.csi.normalizeDelays, false);
});

test('coverage quick start defines a small rectangular ENU grid and reproducible settings', () => {
  const setup = starterExperiment('coverage');
  assert.deepEqual(setup.coverageRegion, { minX: -48, maxX: 48, minY: -24, maxY: 24 });
  assert.equal(setup.coverageGridM, 8);
  assert.equal(setup.coverageThresholdDb, -90);
});

test('shows actual trajectory interval when the requested spacing exceeds the 100-point limit', () => {
  const points = [0, 100].map(x => ({ lat: 0, lon: 0, enu: { x, y: 0, z: 0 } }));
  const route = sampleTrajectory(points, 250, 3.6, true);
  const summary = trajectorySampling(route.timeSeconds, 250);
  assert.equal(summary?.sampleCount, 100);
  assert.equal(summary?.capped, true);
  assert.ok(summary && Math.abs(summary.intervalMs - 100_000 / 99) < 1e-9);
  assert.equal(trajectorySampling([], 250), null);
});
