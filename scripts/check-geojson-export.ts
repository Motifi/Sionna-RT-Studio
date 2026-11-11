import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BuildingFootprint } from '../src/types.ts';
import { exportGeoJSON } from '../src/utils.ts';

const anchor = { latitude: 0, longitude: 0 };
const object: BuildingFootprint = {
  id: 'object', category: 'building', type: 'generic', material: 'itu_concrete',
  height: 5, points: [], enuPoints: [],
};

const feature = (overrides: Partial<BuildingFootprint>) =>
  JSON.parse(exportGeoJSON([{ ...object, ...overrides }], anchor)).features[0];

test('walls and existing linear features export open LineStrings', () => {
  const enuPoints = [{ x: 0, y: 0, z: 0 }, { x: 111320, y: 0, z: 0 }];
  for (const kind of ['wall', undefined] as const) {
    assert.deepEqual(feature({ kind, enuPoints }).geometry,
      { type: 'LineString', coordinates: [[0, 0], [1, 0]] });
  }

  const road = feature({ category: 'infrastructure', type: 'road', points: [
    { lon: 1, lat: 1 }, { lon: 2, lat: 1 }, { lon: 2, lat: 3 },
  ] });
  assert.deepEqual(road.geometry, { type: 'LineString', coordinates: [[1, 1], [2, 1], [2, 3]] });
});

test('mesh footprint uses the projected triangle vertices even without stored bounds', () => {
  const mesh = { vertices: [0, 0, 0, 222640, 0, 1, 0, 110574, 2, 111320, 0, 3, 500000, 500000, 0],
    triangles: [0, 3, 2, 3, 1, 2] };
  const expected = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [0, 1], [0, 0]]] };
  assert.deepEqual(feature({ kind: 'mesh', mesh }).geometry, expected);
  assert.deepEqual(feature({ kind: 'mesh', mesh, points: [{ lon: 0, lat: 0 }, { lon: 2, lat: 1 }] }).geometry, expected);
});

test('collinear and coincident mesh projections use a LineString and Point', () => {
  const triangles = [0, 1, 2];
  const wall = feature({ kind: 'mesh', mesh: { vertices: [0, 0, 0, 111320, 110574, 2, 222640, 221148, 0], triangles } });
  assert.deepEqual(wall.geometry, { type: 'LineString', coordinates: [[0, 0], [2, 2]] });

  const point = feature({ kind: 'mesh', mesh: { vertices: [0, 0, 0, 0, 0, 1, 0, 0, 2], triangles } });
  assert.deepEqual(point.geometry, { type: 'Point', coordinates: [0, 0] });
});

test('ordinary polygon coordinates and properties survive, with a closed CCW exterior', () => {
  const points = [{ lon: 2, lat: 0 }, { lon: 2, lat: 1 }, { lon: 0, lat: 1 }, { lon: 2, lat: 0 }];
  const expected = { type: 'Polygon', coordinates: [[[2, 0], [2, 1], [0, 1], [2, 0]]] };
  const building = feature({ points, name: 'Test building', levels: 2 });
  assert.deepEqual(building.geometry, expected);
  assert.deepEqual(building.properties, { id: 'object', category: 'building', type: 'generic',
    material: 'itu_concrete', height: 5, name: 'Test building', levels: 2 });
  assert.deepEqual(feature({ points: [...points].reverse() }).geometry, expected);
  assert.equal(feature({}).geometry, null);
});
