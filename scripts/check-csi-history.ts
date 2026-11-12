import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../src/api';
import * as trajectory from '../src/lib/trajectory';

test('history requests are scoped to the selected project and preserve archived metadata by default', async () => {
  const requests: { url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response('[]');
  };
  try {
    await api.listCsiRuns('project-a');
    await api.readCsiRun('project-a', 'run-b');
    await api.inspectCsiLink('run-b', { txId: 'ap', rxId: 'ue', sampleIndex: 2 }, 'project-a');
    await api.exportCsiRun('run-b', undefined, 'project-a');
    assert.deepEqual(requests.map(request => request.url), [
      '/api/projects/project-a/csi-runs',
      '/api/projects/project-a/csi-runs/run-b',
      '/api/csi-runs/run-b/preview?sampleIndex=2&txId=ap&rxId=ue&projectId=project-a',
      '/api/csi-runs/run-b/export?projectId=project-a',
    ]);
    assert.deepEqual(requests[3].body, {});
  } finally {
    globalThis.fetch = original;
  }
});

test('historical markers use the actual resolved ENU coordinates', () => {
  const device = { height: 1, heightReference: 'roof' as const, enu: { x: 0, y: 0, z: 0 } };
  assert.deepEqual(trajectory.deviceAtRunPosition(device, [12, -4, 7]), {
    height: 7, heightReference: 'enu', enu: { x: 12, y: -4, z: 7 },
  });
  assert.equal(trajectory.deviceAtRunPosition(device, undefined), device);
});
