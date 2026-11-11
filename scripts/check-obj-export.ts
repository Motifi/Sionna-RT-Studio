import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BuildingFootprint, ENUVector } from '../src/types.ts';
import { exportOBJ3D } from '../src/utils.ts';

const point = (x: number, y: number): ENUVector => ({ x, y, z: 0 });
const footprint = {
  id: 'building', category: 'building', type: 'generic', material: 'itu_concrete',
  height: 4, baseZ: 7, points: [], enuPoints: [point(0, 0), point(5, 0), point(0, 5)],
} satisfies BuildingFootprint;
const wall: BuildingFootprint = {
  ...footprint, id: 'wall', kind: 'wall', baseZ: -2, enuPoints: [point(10, 0), point(10, 5)],
};
const mesh: BuildingFootprint = {
  ...footprint, id: 'mesh', kind: 'mesh', baseZ: 2, enuPoints: [point(20, 0), point(21, 1)],
  mesh: { vertices: [20, 0, 0, 20, 1, 2, 21, 0, 0], triangles: [0, 2, 1] },
};

function geometry(obj: string, type: 'v' | 'f') {
  return obj.split('\n').filter(line => line.startsWith(`${type} `))
    .map(line => line.trim().split(/\s+/).slice(1).map(Number));
}

test('a wall exports its two triangles at the configured height and base', () => {
  const obj = exportOBJ3D([wall]);
  assert.deepEqual(geometry(obj, 'v'), [[10, 0, -2], [10, 5, -2], [10, 5, 2], [10, 0, 2]]);
  assert.deepEqual(geometry(obj, 'f'), [[1, 2, 3], [1, 3, 4]]);
});

test('a mixed OBJ uses global one-based indices for imported triangles', () => {
  const obj = exportOBJ3D([footprint, wall, mesh]);
  assert.deepEqual(geometry(obj, 'v').slice(10), [[20, 0, 2], [20, 1, 4], [21, 0, 2]]);
  assert.deepEqual(geometry(obj, 'f').slice(5), [[7, 8, 9], [7, 9, 10], [11, 13, 12]]);
});

test('a building exports its base and top in absolute ENU elevation', () => {
  const elevations = geometry(exportOBJ3D([footprint]), 'v').map(vertex => vertex[2]);
  assert.deepEqual(elevations, [7, 7, 7, 11, 11, 11]);
});
