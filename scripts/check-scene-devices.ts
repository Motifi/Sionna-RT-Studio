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

test('roof-relative devices use the highest effective roof regardless of building order', () => {
  const device = { enu: { x: 2, y: 2, z: 0 }, height: 1 };
  const lower = { ...building, id: 'low', baseZ: 0, height: 8 };
  const higher = { ...building, id: 'high', baseZ: 6, height: 12 };
  assert.equal(getDeviceElevation(device, [lower, higher]), 19);
  assert.equal(getDeviceElevation(device, [higher, lower]), 19);
  assert.equal(getDeviceElevation({ ...device, heightReference: 'enu' }, [lower, higher]), 1);
});

test('the roof must have a valid area and contain the device strictly inside', () => {
  const device = { enu: { x: 2, y: 2, z: 0 }, height: 1 };
  const tiny = { ...building, height: 50, enuPoints: building.enuPoints.map(({ x, y, z }) => ({
    x: 1.9 + x / 10, y: 1.9 + y / 10, z,
  })) };
  const thin = { ...building, height: 0.4, baseZ: 3 };
  assert.equal(getDeviceElevation(device, [tiny, thin]), 5);
  assert.equal(getDeviceElevation(device, [{ ...building, height: 0 }]), 1);
  assert.equal(getDeviceElevation({ ...device, enu: { ...device.enu, x: 0 } }, [building]), 1);
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
