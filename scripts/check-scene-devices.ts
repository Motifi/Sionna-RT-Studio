import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BuildingFootprint } from '../src/types.ts';
import { createIdSuffix, getDeviceElevation } from '../src/utils.ts';

const building: BuildingFootprint = {
  id: 'roof', kind: 'building', type: 'building', category: 'building',
  baseZ: 7, height: 12, material: 'itu_concrete', points: [],
  enuPoints: [
    { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 },
    { x: 4, y: 4, z: 0 }, { x: 0, y: 4, z: 0 },
  ],
};

test('absolute and legacy roof-relative device elevations use the same rendering rule', () => {
  const enu = { x: 2, y: 2, z: 0 };
  assert.equal(getDeviceElevation({ enu, height: 5, heightReference: 'enu' }, [building]), 5);
  assert.equal(getDeviceElevation({ enu, height: -2, heightReference: 'enu' }, [building]), -2);
  assert.equal(getDeviceElevation({ enu, height: 5 }, [building]), 24);
  assert.equal(getDeviceElevation({ enu: { x: 8, y: 8, z: 0 }, height: 5 }, [building]), 5);
});

test('editor IDs can be generated when the browser omits randomUUID on HTTP', () => {
  const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  try {
    const first = createIdSuffix();
    assert.match(first, /^\d+-\d+-\d+-\d+$/);
    assert.notEqual(createIdSuffix(), first);
  } finally {
    if (original) Object.defineProperty(crypto, 'randomUUID', original);
    else Reflect.deleteProperty(crypto, 'randomUUID');
  }
});
