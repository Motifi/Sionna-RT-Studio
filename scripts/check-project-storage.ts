import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearAutosavedProject, createProjectDocument, DEFAULT_CSI_SETTINGS, loadAutosavedProject,
  parseProjectDocument, PROJECT_STORAGE_KEY, replaceUnreadableAutosave, saveAutosavedProject, type StudioProjectState,
} from '../src/project';
import { DEFAULT_SOLVER_OPTIONS } from '../src/types';

const enu = { x: 0, y: 0, z: 0 };
const device = { id: 'device', name: 'Device', latitude: 0, longitude: 0, height: 1, enu, antennaArraySize: [1, 1] as [number, number] };
const project: StudioProjectState = {
  scene: { coordinateFrame: 'ENU_m', anchor: { latitude: 0, longitude: 0 }, buildings: [] },
  devices: {
    transmitters: [{ ...device, powerDbm: 30, beamsteeringAzimuth: 0, beamsteeringElevation: 0 }],
    receivers: [device], activeTxId: device.id, activeRxId: device.id, fronthaulMbpsByTxId: {},
  },
  solver: { carrierFrequencyGhz: 28, maxDepth: 3, options: DEFAULT_SOLVER_OPTIONS, materialConfigs: {} },
  csi: DEFAULT_CSI_SETTINGS,
  coverage: { metric: 'power', bandwidthMhz: 100, noiseFigureDb: 7, heightM: 1.5, gridStepM: 8, samplesPerTx: 1000, seed: 42 },
  mobility: {
    trajectoriesByRxId: {}, combineMode: 'best_server', speedKmh: 30, intervalMs: 100,
    handover: { hysteresisDb: 3, timeToTriggerMs: 160 },
  },
  display: {
    workspace: 'scene', activeMode: 'link', showOutlines: true, showRaysOnHeatmap: false,
    radioMapColormap: 'viridis', radioMapAutoRange: true, radioMapVmin: -120, radioMapVmax: -50,
  },
};

test('round trips a scene with georeferencing, tree physics, and offline visual bindings', () => {
  const state = structuredClone(project);
  state.scene.anchor = { latitude: 31, longitude: 121, elevation: 8.2, verticalDatum: 'local' };
  state.scene.buildings = [{
    id: 'tree', name: 'Tree', kind: 'building', category: 'terrain', type: 'tree',
    rfRole: 'foliage', geometrySource: 'example', material: 'itu_wood', height: 6,
    enuPoints: [enu], points: [{ lat: 31, lon: 121 }],
    foliage: { center: { ...enu, z: 4 }, radii: { x: 2, y: 2, z: 3 }, attenuationDbPerM: 0.8 },
  }];
  state.scene.visual = { glb: 'Z2xURgIAAAAAAA==', bindings: [{ id: 'tree', origin: enu }] };
  const doc = createProjectDocument(state);
  assert.equal(doc.schemaVersion, 5);
  assert.deepEqual(parseProjectDocument(JSON.stringify(doc)).state.scene, state.scene);
  assert.equal(parseProjectDocument({ ...createProjectDocument(project), schemaVersion: 3 }).schemaVersion, 5);
  state.scene.buildings[0].foliage!.radii.x = 0;
  assert.throws(() => parseProjectDocument(createProjectDocument(state)), /invalid settings/);
});

test('restores an editable generated building with its mesh and generation parameters', () => {
  const state = structuredClone(project);
  state.scene.buildings = [{
    id: 'office--1f-facade', kind: 'mesh', category: 'building', type: 'generated_facade',
    rfRole: 'surface', material: 'itu_concrete', height: 4, floor: '1F', enuPoints: [], points: [],
    mesh: { vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1], triangles: [0, 1, 2] },
    buildingSpec: { id: 'office', name: '研究楼', layout: 'office', east: 0, north: 0, baseZ: 0,
      length: 24, width: 16, height: 12, floors: 3, rotationDeg: 20 },
  }];
  assert.deepEqual(parseProjectDocument(JSON.stringify(createProjectDocument(state))).state.scene, state.scene);
  state.scene.buildings[0].buildingSpec!.id = 'another-building';
  assert.throws(() => parseProjectDocument(createProjectDocument(state)), /invalid settings/);
});

// Model the Web Storage quota and the boundary at which an IndexedDB transaction
// commits. The fixture can abort a write after its requests have run.
function setupStorage() {
  const old = new Map<string, string>();
  const records = new Map<string, unknown>();
  let failCommit = false;
  let afterWrite: (() => void) | undefined;
  let created = false;
  const localStorage = {
    getItem: (key: string) => old.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key.length + value.length > 5 * 1024 ** 2) throw new DOMException('Web Storage quota exceeded', 'QuotaExceededError');
      old.set(key, value);
    },
    removeItem: (key: string) => old.delete(key),
  };
  const database = {
    close() {},
    createObjectStore() { created = true; },
    transaction() {
      const writes: (() => void)[] = [];
      const transaction = {
        oncomplete: () => {},
        onabort: () => {},
        error: undefined as DOMException | undefined,
        objectStore: () => ({
          get(key: string) {
            const request = { result: undefined as unknown, onsuccess: () => {} };
            queueMicrotask(() => {
              request.result = structuredClone(records.get(key));
              request.onsuccess();
            });
            return request;
          },
          put(value: unknown, key: string) { writes.push(() => { records.set(key, structuredClone(value)); }); },
        }),
      };
      setImmediate(() => {
        if (failCommit && writes.length) {
          failCommit = false;
          transaction.error = new DOMException('Project write aborted', 'QuotaExceededError');
          transaction.onabort();
        } else {
          writes.forEach(write => write());
          if (writes.length) {
            const callback = afterWrite;
            afterWrite = undefined;
            callback?.();
          }
          transaction.oncomplete();
        }
      });
      return transaction;
    },
  };
  const indexedDB = {
    open() {
      const request = { result: database, onupgradeneeded: () => {}, onsuccess: () => {} };
      queueMicrotask(() => {
        if (!created) request.onupgradeneeded();
        request.onsuccess();
      });
      return request;
    },
  };
  Object.assign(globalThis, { window: { localStorage, indexedDB }, localStorage });
  return {
    localStorage,
    abortNextCommit: () => { failCommit = true; },
    afterNextWrite: (callback: () => void) => { afterWrite = callback; },
    seedAutosave: (value: unknown) => records.set(PROJECT_STORAGE_KEY, value),
    readAutosave: () => records.get(PROJECT_STORAGE_KEY),
    readBackup: () => records.get(`${PROJECT_STORAGE_KEY}.pre-v5`),
  };
}

test('restores a supported project mesh larger than the Web Storage quota', async () => {
  setupStorage();
  const large: StudioProjectState = {
    ...project,
    scene: {
      ...project.scene,
      buildings: [{
        id: 'large-mesh', kind: 'mesh', category: 'building', source: 'import', type: '', material: 'itu_concrete',
        height: 1, enuPoints: [], points: [],
        mesh: {
          vertices: Array.from({ length: 300_000 }, (_, index) => Math.sin(index)),
          triangles: Array.from({ length: 450_000 }, (_, index) => index % 100_000),
        },
      }],
    },
  };
  assert.ok(JSON.stringify(large).length > 5 * 1024 ** 2);
  await saveAutosavedProject(large);
  assert.deepEqual((await loadAutosavedProject())?.state, large);
});

test('keeps an older autosave when migration aborts and restores it on retry', async () => {
  const { localStorage, abortNextCommit } = setupStorage();
  const legacy = createProjectDocument(project);
  const { coordinateFrame, ...oldScene } = legacy.state.scene;
  assert.equal(coordinateFrame, 'ENU_m');
  const raw = JSON.stringify({ ...legacy, schemaVersion: 2, state: { ...project, scene: oldScene } });
  localStorage.setItem(PROJECT_STORAGE_KEY, raw);
  abortNextCommit();
  await assert.rejects(async () => loadAutosavedProject(), /Project write aborted/);
  assert.equal(localStorage.getItem(PROJECT_STORAGE_KEY), raw);
  assert.deepEqual((await loadAutosavedProject())?.state, project);
  assert.equal(localStorage.getItem(PROJECT_STORAGE_KEY), null);
});

test('an older in-flight save cannot resurrect a cleared project', async () => {
  setupStorage();
  const save = saveAutosavedProject(project);
  const clear = clearAutosavedProject();
  await Promise.all([save, clear]);
  assert.equal(await loadAutosavedProject(), null);
});

test('keeps a legacy-only project if resetting the database fails', async () => {
  const { localStorage, abortNextCommit } = setupStorage();
  const raw = JSON.stringify(createProjectDocument(project));
  localStorage.setItem(PROJECT_STORAGE_KEY, raw);
  abortNextCommit();
  await assert.rejects(async () => clearAutosavedProject(), /Project write aborted/);
  assert.equal(localStorage.getItem(PROJECT_STORAGE_KEY), raw);
});

test('distinguishes an unreadable legacy autosave from an unavailable store', async () => {
  const { localStorage } = setupStorage();
  localStorage.setItem(PROJECT_STORAGE_KEY, '{unreadable');
  await assert.rejects(loadAutosavedProject, { name: 'UnreadableAutosaveError' });
  assert.equal(localStorage.getItem(PROJECT_STORAGE_KEY), '{unreadable');
});

test('replaces an unreadable legacy autosave only after a successful write', async () => {
  const { localStorage, abortNextCommit } = setupStorage();
  localStorage.setItem(PROJECT_STORAGE_KEY, '{unreadable');
  abortNextCommit();
  await assert.rejects(() => replaceUnreadableAutosave(project), /Project write aborted/);
  assert.equal(localStorage.getItem(PROJECT_STORAGE_KEY), '{unreadable');
  assert.equal(await replaceUnreadableAutosave(project), true);
  assert.deepEqual((await loadAutosavedProject())?.state, project);
  assert.equal(localStorage.getItem(PROJECT_STORAGE_KEY), null);
});

test('preserves an unreadable database record when replacing it aborts', async () => {
  const { seedAutosave, readAutosave, abortNextCommit } = setupStorage();
  const invalid = { format: 'SionnaRTStudio Project', schemaVersion: 3, state: { incomplete: true } };
  seedAutosave(invalid);
  await assert.rejects(loadAutosavedProject, { name: 'UnreadableAutosaveError' });
  abortNextCommit();
  await assert.rejects(() => replaceUnreadableAutosave(project), /Project write aborted/);
  assert.deepEqual(readAutosave(), invalid);
  assert.equal(await replaceUnreadableAutosave(project), true);
  assert.deepEqual((await loadAutosavedProject())?.state, project);
});

test('recovery preserves a valid project saved by another session', async () => {
  const { localStorage, seedAutosave } = setupStorage();
  localStorage.setItem(PROJECT_STORAGE_KEY, '{unreadable');
  await assert.rejects(loadAutosavedProject, { name: 'UnreadableAutosaveError' });
  const newer = { ...project, coverage: { ...project.coverage, seed: 123 } };
  seedAutosave(createProjectDocument(newer));
  assert.equal(await replaceUnreadableAutosave(project), false);
  assert.deepEqual((await loadAutosavedProject())?.state, newer);
});

test('recovery refuses a replacement that Studio cannot restore', async () => {
  const { localStorage } = setupStorage();
  localStorage.setItem(PROJECT_STORAGE_KEY, '{unreadable');
  const invalid = { ...project, devices: { ...project.devices, receivers: [] } };
  await assert.rejects(() => replaceUnreadableAutosave(invalid), /project file is incomplete/);
  assert.equal(localStorage.getItem(PROJECT_STORAGE_KEY), '{unreadable');
});

test('treats a newer autosave as incompatible and preserves it during recovery', async () => {
  const { localStorage, seedAutosave, readAutosave } = setupStorage();
  localStorage.setItem(PROJECT_STORAGE_KEY, '{unreadable');
  await assert.rejects(loadAutosavedProject, { name: 'UnreadableAutosaveError' });
  const future = { ...createProjectDocument(project), schemaVersion: 6 };
  seedAutosave(future);
  await assert.rejects(loadAutosavedProject, { name: 'FutureAutosaveError' });
  assert.equal(await replaceUnreadableAutosave(project), false);
  assert.deepEqual(readAutosave(), future);
});

test('preserves a different legacy value written during a recovery transaction', async () => {
  const { localStorage, afterNextWrite } = setupStorage();
  localStorage.setItem(PROJECT_STORAGE_KEY, '{unreadable');
  const newer = JSON.stringify(createProjectDocument(project));
  afterNextWrite(() => localStorage.setItem(PROJECT_STORAGE_KEY, newer));
  assert.equal(await replaceUnreadableAutosave(project), true);
  assert.equal(localStorage.getItem(PROJECT_STORAGE_KEY), newer);
  assert.deepEqual((await loadAutosavedProject())?.state, project);
});

test('migrates an existing IndexedDB v4 autosave once and keeps a rollback copy', async () => {
  const { seedAutosave, readAutosave, readBackup } = setupStorage();
  const v4 = { format: 'SionnaRTStudio Project', schemaVersion: 4, savedAtUtc: '2026-11-11T00:00:00Z', state: project };
  seedAutosave(v4);
  const [first, second] = await Promise.all([loadAutosavedProject(), loadAutosavedProject()]);
  assert.ok(first && second);
  assert.match(first.projectId, /^[0-9a-f-]{36}$/);
  assert.equal(first.projectId, second.projectId);
  assert.equal(first.schemaVersion, 5);
  assert.deepEqual(readAutosave(), first);
  assert.deepEqual(readBackup(), v4);
  await saveAutosavedProject(project, first.projectId);
  assert.equal((await loadAutosavedProject())?.projectId, first.projectId);
});

test('round trips a v5 project identity and an absolute ENU trajectory', () => {
  const state = structuredClone(project);
  state.mobility.trajectoriesByRxId[device.id] = [{ lat: 0, lon: 0, enu: { ...enu, z: 6 } }];
  state.mobility.waypointFrameByRxId = { [device.id]: 'ENU_m' };
  const exported = createProjectDocument(state, '11111111-2222-4333-8444-555555555555');
  const restored = parseProjectDocument(JSON.stringify(exported));
  assert.equal(restored.projectId, exported.projectId);
  assert.deepEqual(restored.state.mobility, state.mobility);
  assert.throws(() => parseProjectDocument({ ...exported, projectId: '../another-project' }), /project ID/i);
});

test('a project reopens while the user is still editing inverted coverage bounds', () => {
  const state = structuredClone(project);
  state.coverage.region = { minX: 40, maxX: 30, minY: -5, maxY: 20 };
  state.coverage.floorId = 'removed-slab';
  state.coverage.thresholdDb = -90;
  const saved = createProjectDocument(state);
  assert.deepEqual(parseProjectDocument(JSON.stringify(saved)).state.coverage, state.coverage);
});
