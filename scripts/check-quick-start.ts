import assert from 'node:assert/strict';
import { test } from 'node:test';
import { starterExperiment } from '../src/lib/experimentPresets';
import { sampleTrajectory, trajectorySampling } from '../src/lib/trajectory';
import type { BuildingFootprint } from '../src/types';
import { getWaypointPosition } from '../src/utils';

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

test('terrain trajectory timing and sampling use resolved 3D waypoints', () => {
  const ground: BuildingFootprint = {
    id: 'slope', kind: 'mesh', type: 'terrain', category: 'terrain', rfRole: 'ground',
    height: 0, material: 'itu_concrete', points: [], enuPoints: [],
    mesh: { vertices: [0, 0, 0, 10, 0, 10, 10, 2, 10, 0, 2, 0], triangles: [0, 1, 2, 0, 2, 3] },
  };
  const points = [0, 10].map(x => ({ lat: 0, lon: 0, enu: { x, y: 1, z: 0 } }));
  const route = sampleTrajectory(points, 1000, 3.6, false,
    enu => getWaypointPosition(enu, { height: 1.5, heightReference: 'ground' }, [ground]));
  assert.equal(route.waypoints.length, 16);
  assert.deepEqual(route.waypoints[0], points[0].enu);
  assert.deepEqual(route.waypoints.at(-1), points[1].enu);
  assert.ok(Math.abs(route.timeSeconds.at(-1)! - 14.1421356237) < 1e-9);
});

test('terrain trajectory resolves intermediate elevations as well as control points', () => {
  const ground: BuildingFootprint = {
    id: 'ridge', kind: 'mesh', type: 'terrain', category: 'terrain', rfRole: 'ground',
    height: 0, material: 'itu_concrete', points: [], enuPoints: [],
    mesh: { vertices: [0, 0, 0, 5, 0, 5, 10, 0, 0, 0, 2, 0, 5, 2, 5, 10, 2, 0],
      triangles: [0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4] },
  };
  const points = [0, 10].map(x => ({ lat: 0, lon: 0, enu: { x, y: 1, z: 0 } }));
  const route = sampleTrajectory(points, 2500, 3.6, false,
    enu => getWaypointPosition(enu, { height: 1.5, heightReference: 'ground' }, [ground]));
  const crest = route.waypoints.findIndex(point => point.x === 5);
  assert.notEqual(crest, -1);
  assert.ok(Math.abs(route.timeSeconds[crest] - 7.07106781187) < 1e-9);
  assert.ok(Math.abs(route.timeSeconds.at(-1)! - 14.1421356237) < 1e-9);
});
