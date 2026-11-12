// Injected by the desktop shell only for an isolated acceptance run.
(async () => {
  if (window.studioDesktopAcceptanceStarted) return;
  window.studioDesktopAcceptanceStarted = true;

  const waitFor = async (label, check, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    do {
      const value = await check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 75));
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${label}`);
  };

  const button = selector => waitFor(selector, () => {
    const control = document.querySelector(selector);
    return control && !control.disabled && control;
  });

  const go = async workspace => {
    const nav = await button('#nav-btn-' + workspace);
    nav.click();
    await waitFor(workspace, () => nav.getAttribute('aria-current') === 'page');
  };

  const savedProject = async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('sionna-rt-studio', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains('projects')) return null;
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('projects');
        const request = transaction.objectStore('projects').get('sionna-rt-studio.project.v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  };

  const exportInfo = async ({ filename, blob }) => {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return { filename, bytes: blob.size, sha256 };
  };

  const report = result => {
    location.assign('/__studio_desktop_acceptance?' + new URLSearchParams({ data: JSON.stringify(result) }));
  };

  const fetchRequest = window.fetch;
  const createObjectURL = URL.createObjectURL;
  const anchorClick = HTMLAnchorElement.prototype.click;

  try {
    const canvas = await waitFor('WebGL2 canvas', () => {
      const canvas = document.querySelector('#canvas-3d');
      const context = canvas?.getContext('webgl2');
      return context && !context.isContextLost() && canvas;
    }, 30000);
    for (const workspace of ['scene', 'planning', 'preview', 'export', 'preview']) {
      await go(workspace);
      if (document.querySelector('#canvas-3d') !== canvas) {
        throw new Error('Workspace navigation replaced the WebGL2 canvas');
      }
    }
    const initialProject = await waitFor('initial autosave', async () => (await savedProject())?.projectId);
    document.querySelector('#project-menu-trigger').closest('details').open = true;
    (await button('#btn-reset-project')).click();
    await waitFor('project reset confirmation', () => document.querySelector('#project-confirmation[open]'));
    (await button('#btn-cancel-project-confirmation')).click();
    await waitFor('dismissed reset confirmation', () => !document.querySelector('#project-confirmation[open]'));
    if ((await savedProject())?.projectId !== initialProject) {
      throw new Error('Canceling reset changed the autosaved project');
    }

    const jobs = new Set();
    let completedJob;
    window.fetch = async (input, options) => {
      const response = await fetchRequest.call(window, input, options);
      const path = new URL(input instanceof Request ? input.url : input, location.href).pathname;
      const isSubmission = path === '/api/simulation-jobs/csi' && options?.method === 'POST';
      if (response.ok && (isSubmission || jobs.has(path.split('/').at(-1)))) {
        const job = await response.clone().json();
        jobs.add(job.jobId);
        if (['succeeded', 'failed', 'cancelled'].includes(job.status)) completedJob = job;
      }
      return response;
    };

    document.querySelector('#experiment-presets').open = true;
    const preset = await button('#btn-load-example-static');
    preset.click();
    await waitFor('offline static CSI example', () => preset.getAttribute('aria-pressed') === 'true');
    (await button('#btn-csi-mode-static')).click();
    (await button('#btn-run-csi-static')).click();
    const job = await waitFor('static CSI job', () => completedJob, 90000);
    if (job.status !== 'succeeded' || !job.result?.projectId || !job.result?.runId) {
      throw new Error('Static CSI job failed: ' + (job.error || job.status));
    }
    const { projectId, runId } = job.result;
    window.dispatchEvent(new Event('sionna-studio-flush-project'));
    await waitFor('IndexedDB autosave', async () => {
      if (document.documentElement.dataset.projectSaveState !== 'saved') return false;
      return (await savedProject())?.projectId === projectId;
    });

    const history = await fetchRequest.call(window, `/api/projects/${projectId}/csi-runs`);
    if (!history.ok || !(await history.json()).some(run => run.runId === runId)) {
      throw new Error('CSI run is missing from project history');
    }

    const blobs = new Map();
    const exports = new Map();
    URL.createObjectURL = function (blob) {
      const url = createObjectURL.call(this, blob);
      if (blob instanceof Blob) blobs.set(url, blob);
      return url;
    };
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && blobs.has(this.href)) {
        exports.set(this.download.split('.').at(-1), { filename: this.download, blob: blobs.get(this.href) });
      }
      return anchorClick.call(this);
    };

    await go('export');
    document.querySelector('#project-menu-trigger').closest('details').open = true;
    (await button('#btn-export-project')).click();
    const project = await waitFor('project export', () => exports.get('json'));
    const json = JSON.parse(await project.blob.text());
    if (json.format !== 'SionnaRTStudio Project' || json.projectId !== projectId) {
      throw new Error('Exported project does not preserve the project ID');
    }
    (await button('#btn-export-csi-run')).click();
    const csi = await waitFor('CSI ZIP export', () => exports.get('zip'));
    const signature = new DataView(await csi.blob.slice(0, 4).arrayBuffer()).getUint32(0, true);
    if (signature !== 0x04034b50) throw new Error('CSI export does not have a ZIP signature');

    report({
      ok: true,
      uiReady: true,
      webgl2: true,
      workspaceNavigation: true,
      projectAutosave: true,
      projectResetConfirmation: true,
      projectId,
      runId,
      exports: await Promise.all([exportInfo(project), exportInfo(csi)]),
    });
  } catch (error) {
    report({ ok: false, error: String(error?.message || error) });
  } finally {
    window.fetch = fetchRequest;
    URL.createObjectURL = createObjectURL;
    HTMLAnchorElement.prototype.click = anchorClick;
  }
})();
