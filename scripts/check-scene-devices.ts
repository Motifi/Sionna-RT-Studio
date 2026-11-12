import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BufferGeometry, Euler, Float32BufferAttribute, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import type { BuildingFootprint } from '../src/types.ts';
import { findHorizontalSurface, isFloorSurface } from '../src/lib/sceneGeometry.ts';
import { advanceWalkCamera, createWalkCamera, rotateWalkCamera } from '../src/lib/sceneWalkCamera.ts';
import { sampleTrajectory } from '../src/lib/trajectory.ts';
import { createIdSuffix, getDeviceElevation, getWaypointPosition } from '../src/utils.ts';

const building: BuildingFootprint = {
  id: 'roof', kind: 'building', type: 'building', category: 'building',
  baseZ: 7, height: 12, material: 'itu_concrete', points: [],
  enuPoints: [
    { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 },
    { x: 4, y: 4, z: 0 }, { x: 0, y: 4, z: 0 },
  ],
};

const slope: BuildingFootprint = {
  id: 'slope', kind: 'mesh', type: 'terrain', category: 'terrain', rfRole: 'ground',
  height: 0, material: 'itu_concrete', points: [], enuPoints: [],
  mesh: { vertices: [0, 0, 0, 4, 0, 4, 4, 4, 4, 0, 4, 0], triangles: [0, 1, 2, 0, 2, 3] },
};

test('ground-relative antenna follows terrain through the building footprint and reports terrain gaps', () => {
  const device = { enu: { x: 2, y: 2, z: 0 }, height: 1.5, heightReference: 'ground' as const };
  assert.equal(getDeviceElevation(device, [building, slope]), 3.5);
  assert.equal(getDeviceElevation(device, [building]), 1.5);
  const partialGround = { ...slope, mesh: { vertices: slope.mesh!.vertices, triangles: [0, 1, 2] } };
  assert.equal(getDeviceElevation({ ...device, enu: { x: 1, y: 3, z: 0 } }, [partialGround]), undefined);
});

test('horizontal picking respects the selected physical floor ID and rejects a hole', () => {
  const slab = (id: string, z: number, hasHole = false) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([
      0, z, 0, 4, z, 0, 4, z, -4, 0, z, -4,
      1, z, -1, 3, z, -1, 3, z, -3, 1, z, -3,
    ], 3));
    geometry.setIndex(hasHole
      ? [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
      : [0, 1, 2, 0, 2, 3]);
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    mesh.name = id;
    mesh.userData.floor = 'Level';
    return mesh;
  };
  const lower = slab('slab-lower', 4);
  const upper = slab('slab-upper', 7);
  const raycaster = new Raycaster(new Vector3(2, 10, -2), new Vector3(0, -1, 0));
  const hits = raycaster.intersectObjects([lower, upper]);
  for (const [target, expectedZ] of [[lower, 5.5], [upper, 8.5]] as const) {
    const hit = findHorizontalSurface(hits, object => object.name === target.name);
    assert.ok(hit);
    const enu = { x: hit.point.x, y: -hit.point.z, z: hit.point.y + 1.5 };
    assert.equal(getDeviceElevation({ enu, height: enu.z, heightReference: 'enu' }, [slope]), expectedZ);
  }
  const upperWithHole = slab('slab-upper', 7, true);
  assert.equal(findHorizontalSurface(raycaster.intersectObjects([lower, upperWithHole]),
    object => object.name === upperWithHole.name), undefined);
});

test('placement choices include floor slabs and omit vertical or visual geometry', () => {
  const mesh = { vertices: [0, 0, 0, 4, 0, 0, 0, 4, 0], triangles: [0, 1, 2] };
  const floor: BuildingFootprint = { ...building, kind: 'mesh', floor: 'Level', rfRole: 'surface', mesh };
  assert.equal(isFloorSurface(floor), true);
  assert.equal(isFloorSurface({ ...floor, rfRole: 'visual' }), false);
  assert.equal(isFloorSurface({
    ...floor, mesh: { ...mesh, vertices: [0, 0, 0, 4, 0, 0, 0, 0, 4] },
  }), false);
  const buildingSpec = {
    id: 'office', name: 'Office', east: 0, north: 0, length: 4, width: 4, height: 4, baseZ: 0,
    rotationDeg: 0, layout: 'office' as const,
  };
  assert.equal(isFloorSurface({ ...floor, type: 'generated_slab', buildingSpec }), true);
  assert.equal(isFloorSurface({ ...floor, type: 'generated_facade', buildingSpec }), false);
});

test('route previews resolve old offsets, terrain and absolute ENU coordinates', () => {
  const enu = { x: 2, y: 2, z: 2 };
  assert.deepEqual(getWaypointPosition(enu, { height: 5, heightReference: 'enu' }, [building, slope]), { ...enu, z: 7 });
  assert.deepEqual(getWaypointPosition(enu, { height: 5 }, [building, slope]), { ...enu, z: 24 });
  assert.deepEqual(getWaypointPosition(enu, { height: 1.5, heightReference: 'ground' }, [building, slope]), { ...enu, z: 3.5 });
  assert.deepEqual(getWaypointPosition(enu, { height: 5 }, [building, slope], undefined, 'ENU_m'), enu);
});

test('absolute vertical route samples 3D arc length at 500 ms and retains endpoints', () => {
  const points = [5.5, 8.5].map(z => ({ lat: 0, lon: 0, enu: { x: 2, y: 2, z } }));
  const sampled = sampleTrajectory(points, 500, 3.6, true);
  assert.deepEqual(sampled.timeSeconds, [0, 0.5, 1, 1.5, 2, 2.5, 3]);
  assert.deepEqual(sampled.waypoints, sampled.timeSeconds.map(time => ({ x: 2, y: 2, z: 5.5 + time })));
  const longRoute = [5.5, 105.5].map(z => ({ lat: 0, lon: 0, enu: { x: 2, y: 2, z } }));
  const capped = sampleTrajectory(longRoute, 1, 3.6, true);
  assert.equal(capped.waypoints.length, 100);
  assert.deepEqual(capped.waypoints[0], longRoute[0].enu);
  assert.deepEqual(capped.waypoints.at(-1), longRoute[1].enu);
  assert.equal(capped.timeSeconds.at(-1), 100);
});

test('legacy horizontal sampling keeps the final control point on a repeated XY', () => {
  const points = [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 2 }, { x: 1, y: 0, z: 3 }]
    .map(enu => ({ lat: 0, lon: 0, enu }));
  const sampled = sampleTrajectory(points, 500, 3.6, false);
  assert.deepEqual(sampled.waypoints.at(-1), points[2].enu);
  assert.equal(sampled.timeSeconds.at(-1), 1);
});

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

test('roof-relative markers use the repaired solver footprint when available', () => {
  const crossed = { ...building, baseZ: 0, height: 8, enuPoints: [
    { x: 0, y: 0, z: 0 }, { x: 8, y: 8, z: 0 }, { x: 0, y: 8, z: 0 }, { x: 4, y: 0, z: 0 },
  ] };
  const roofs = [{ topZ: 8, rings: [[{ x: 8, y: 8 }, { x: 8 / 3, y: 8 / 3 }, { x: 0, y: 8 }]] }];
  assert.equal(getDeviceElevation({ enu: { x: 2, y: 1, z: 0 }, height: 1.5 }, [crossed], roofs), 1.5);
  assert.equal(getDeviceElevation({ enu: { x: 3, y: 7, z: 0 }, height: 1.5 }, [crossed], roofs), 9.5);
  assert.equal(getDeviceElevation({ enu: { x: 1.5, y: 5, z: 0 }, height: 1.5 }, [crossed], roofs), 9.5);
  assert.equal(getDeviceElevation({ enu: { x: 3, y: 7, z: 0 }, height: 1.5 }, [crossed], []), 1.5);
});

test('a repaired roof excludes its holes and their boundaries', () => {
  const hole = [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 3 }];
  const roofs = [{ topZ: 19, rings: [building.enuPoints, hole] }];
  assert.equal(getDeviceElevation({ enu: { x: 2, y: 2, z: 0 }, height: 1 }, [building], roofs), 1);
  assert.equal(getDeviceElevation({ enu: { x: 1, y: 2, z: 0 }, height: 1 }, [building], roofs), 1);
  assert.equal(getDeviceElevation({ enu: { x: 0.5, y: 2, z: 0 }, height: 1 }, [building], roofs), 20);
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

test('walk camera starts at eye height and moves in its facing direction on the floor plane', () => {
  const floor = new Vector3(2, 5, -3);
  const state = createWalkCamera(floor, new Vector3(1, -0.8, 0));
  assert.deepEqual(state.position.toArray(), [2, 6.6, -3]);
  rotateWalkCamera(state, 0, -80);
  advanceWalkCamera(state, new Set(['ArrowUp']), 0.02);
  assert.ok(state.position.x > 2);
  assert.equal(state.position.y, 6.6);
  assert.ok(Math.abs(state.position.z + 3) < 1e-10);
  assert.deepEqual(floor.toArray(), [2, 5, -3]);
});

test('dragging the walk camera right and up turns it right and clamps its vertical look', () => {
  const state = createWalkCamera(new Vector3(), new Vector3(0, -1, 0));
  rotateWalkCamera(state, 100, -1e6);
  const look = new Vector3(0, 0, -1).applyEuler(new Euler(state.pitch, state.yaw, 0, 'YXZ'));
  assert.ok(look.x > 0 && look.y > 0 && look.y < 1 && look.z < 0);
  const upperPitch = state.pitch;
  rotateWalkCamera(state, 0, 2e6);
  assert.equal(state.pitch, -upperPitch);
  assert.ok(state.pitch < 0 && state.pitch > -Math.PI / 2);
});

test('walk camera keeps diagonal speed stable and limits movement after a long frame', () => {
  const floor = new Vector3();
  const heading = new Vector3(0, 0, -1);
  const forward = createWalkCamera(floor, heading);
  const diagonal = createWalkCamera(floor, heading);
  const delayed = createWalkCamera(floor, heading);
  advanceWalkCamera(forward, new Set(['KeyW']), 0.05);
  advanceWalkCamera(diagonal, new Set(['KeyW', 'ArrowRight']), 0.05);
  advanceWalkCamera(delayed, new Set(['KeyW']), 10);
  assert.ok(diagonal.position.x > 0 && diagonal.position.z < 0);
  assert.ok(Math.abs(Math.hypot(diagonal.position.x, diagonal.position.z) + forward.position.z) < 1e-10);
  assert.deepEqual(delayed.position.toArray(), forward.position.toArray());
  advanceWalkCamera(diagonal, new Set(['KeyE']), 0.02);
  assert.ok(diagonal.position.y > forward.position.y);
  advanceWalkCamera(diagonal, new Set(['KeyQ']), 0.02);
  assert.equal(diagonal.position.y, forward.position.y);
});
