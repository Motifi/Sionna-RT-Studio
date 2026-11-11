import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearAutosavedProject, createProjectDocument, DEFAULT_CSI_SETTINGS, loadAutosavedProject,
  PROJECT_STORAGE_KEY, saveAutosavedProject, type StudioProjectState,
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

// Model the Web Storage quota and the boundary at which an IndexedDB transaction
// commits. The fixture can abort a write after its requests have run.
function setupStorage() {
  const old = new Map<string, string>();
  const records = new Map<string, unknown>();
  let failCommit = false;
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
  return { localStorage, abortNextCommit: () => { failCommit = true; } };
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
