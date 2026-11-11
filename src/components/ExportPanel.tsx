/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useI18n, type LocalizedText } from '../i18n';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Transmitter, Receiver, BuildingFootprint, GeoAnchor, PropagationPath, RadioMapGrid, SolverOptions, MaterialConfig, ChannelGridConfig } from '../types';
import { exportGeoJSON, exportOBJ3D, exportPropagationCSV, exportCoverageChannelGrid } from '../utils';
import { exportCIR, CIRFormat, exportCIRBundle, exportChannelGrid, exportCsiRun, exportScene, readBackendHealth } from '../api';
import type { CIRExportOptions, CsiRun } from '../api';
import { antennaPortCount, formatCsiBytes } from '../lib/csiSize';
import { createProjectDocument, type ProjectAutosaveStatus, type StudioProjectState } from '../project';
import { FileDown, FileSpreadsheet, Box, Compass, Database, AlertOctagon, Waves, Loader2, FileUp, Save, Package, RotateCcw, Fingerprint } from 'lucide-react';
import { NumberField } from './NumberField';

// Backend cap on ray-traced channel-grid cells (MAX_CHANNEL_GRID_CELLS in
// backend/solver.py) — keep in sync so the UI blocks over-cap exports up front.
const CHANNEL_GRID_MAX_CELLS = 16384;
const DEFAULT_CSI_GRID: CIRExportOptions = { numSubcarriers: 1024, subcarrierSpacing: 30_000, normalizeDelays: true };

interface ExportPanelProps {
  buildings: BuildingFootprint[];
  anchor: GeoAnchor;
  paths: PropagationPath[];
  txs: Transmitter[];
  rxs: Receiver[];
  tx: Transmitter;
  rx: Receiver;
  freqGhz: number;
  maxDepth: number;
  solverOptions: SolverOptions;
  radioMap: RadioMapGrid | null;
  materials: MaterialConfig[];
  projectState: StudioProjectState;
  autosaveStatus: ProjectAutosaveStatus;
  onResetProject: () => void;
  onImportProject: (text: string) => void;
  csiRun?: CsiRun | null;
  csiStale?: boolean;
  csiGrid?: CIRExportOptions;
  fronthaulMbpsByTxId?: Record<string, number | null>;
  onOpenPreview?: () => void;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
};

const sha256Hex = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Band that opens each group of exporter cards. Spans the full grid so the
 * cards below it read as belonging to the heading rather than to the card
 * that happens to precede them.
 */
function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="md:col-span-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-[var(--line)] pb-1.5 mt-2 first:mt-0">
      <h4 className="eyebrow text-[var(--text-hi)] whitespace-nowrap">{title}</h4>
      <p className="text-[12px] text-[var(--text-lo)] leading-snug">{hint}</p>
    </div>
  );
}

export function ExportPanel({
  buildings, anchor, paths, txs, rxs, tx, rx, freqGhz, maxDepth, solverOptions,
  radioMap, materials, projectState, autosaveStatus, onImportProject, onResetProject,
  csiRun = null, csiStale = false, csiGrid = DEFAULT_CSI_GRID, fronthaulMbpsByTxId = {}, onOpenPreview,
}: ExportPanelProps) {
  const { t } = useI18n();
  const { numSubcarriers, subcarrierSpacing, normalizeDelays } = csiGrid;
  const exportableRunId = csiStale ? null : csiRun?.runId ?? null;
  const csiRequest = useRef<symbol | null>(null);
  const [csiBusy, setCsiBusy] = useState(false);
  const [csiError, setCsiError] = useState<{ runId: string; message: string } | null>(null);
  useLayoutEffect(() => {
    setCsiBusy(false);
    return () => { csiRequest.current = null; };
  }, [exportableRunId]);
  const [cirBusy, setCirBusy] = useState<CIRFormat | 'bundle' | null>(null);
  const [cirError, setCirError] = useState('');
  const [exportAllDevices, setExportAllDevices] = useState(false);
  // Standalone Mitsuba/Sionna scene export (scene.xml + meshes + load_scene.py).
  const [sceneBusy, setSceneBusy] = useState(false);
  const [sceneError, setSceneError] = useState('');
  // Coverage-proxy/channel-grid config — OFDM subcarriers + bandwidth.
  const [channelGridConfig, setChannelGridConfig] = useState<ChannelGridConfig>({
    numSubcarriers: 64,
    bandwidthMhz: 100,
  });
  // Export mode: OFF = synthetic in-browser JSON (default, instant);
  // ON = per-cell ray-traced MIMO CFR with Tx/Rx port axes (slow, .npz).
  const [rayTracedGrid, setRayTracedGrid] = useState(false);
  const [channelGridBusy, setChannelGridBusy] = useState(false);
  const [channelGridError, setChannelGridError] = useState('');
  const [manifestBusy, setManifestBusy] = useState(false);
  const [projectMessage, setProjectMessage] = useState<{ kind: 'success' | 'error'; text: LocalizedText } | null>(null);
  const projectFileRef = useRef<HTMLInputElement>(null);
  // Local trigger downloads helper (string content or a ready-made Blob).
  const triggerDownload = (content: string | Blob, filename: string, mimeType?: string) => {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleExportCsiRun = async () => {
    if (!csiRun || !exportableRunId || csiRequest.current) return;
    const request = Symbol();
    csiRequest.current = request;
    setCsiBusy(true);
    setCsiError(null);
    try {
      const fronthaul = Object.fromEntries(csiRun.txIds.map((id) => [id, fronthaulMbpsByTxId[id] ?? null]));
      const { blob, filename } = await exportCsiRun(exportableRunId, fronthaul);
      if (csiRequest.current === request) triggerDownload(blob, filename);
    } catch (error) {
      if (csiRequest.current === request) {
        setCsiError({ runId: exportableRunId, message: error instanceof Error ? error.message : t('CSI download failed', 'CSI 下载失败') });
      }
    } finally {
      if (csiRequest.current === request) {
        csiRequest.current = null;
        setCsiBusy(false);
      }
    }
  };

  const handleExportGeoJSON = () => {
    const geoJsonStr = exportGeoJSON(buildings, anchor);
    triggerDownload(geoJsonStr, 'sionna_rt_studio_building_footprints.geojson', 'application/json');
  };

  const handleExportOBJ = () => {
    const objStr = exportOBJ3D(buildings);
    triggerDownload(objStr, 'sionna_rt_studio_twin_model.obj', 'text/plain');
  };

  const handleExportCSV = () => {
    const csvStr = exportPropagationCSV(paths);
    triggerDownload(csvStr, 'sionna_rt_studio_multipath_rays_report.csv', 'text/csv');
  };

  const handleExportProject = () => {
    const document = createProjectDocument(projectState);
    triggerDownload(
      `${JSON.stringify(document, null, 2)}\n`,
      'sionna_rt_studio_project.json',
      'application/json',
    );
    setProjectMessage({ kind: 'success', text: ['Project file exported.', '项目文件已导出。'] });
  };

  const handleImportProjectFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      onImportProject(await file.text());
      setProjectMessage({
        kind: 'success',
        text: [`Loaded ${file.name}. Computed results were cleared.`, `已载入 ${file.name}。已清除旧的计算结果。`],
      });
    } catch (error) {
      setProjectMessage({
        kind: 'error',
        text: error instanceof Error
          ? [error.message, `无法导入项目文件。${error.message}`]
          : ['Could not import the project file.', '无法导入项目文件。'],
      });
    }
  };

  const handleExportManifest = async () => {
    setManifestBusy(true);
    try {
      const [sceneInputSha256, health] = await Promise.all([sha256Hex(buildings), readBackendHealth()]);
      const featureCounts = buildings.reduce<Record<string, number>>((counts, feature) => {
        counts[feature.category] = (counts[feature.category] ?? 0) + 1;
        return counts;
      }, {});
      const manifest = {
        schemaVersion: 1,
        generatedAtUtc: new Date().toISOString(),
        application: {
          name: 'SionnaRTStudio',
          version: health?.appVersion ?? null,
          engine: 'Sionna RT',
        },
        coordinateConvention: {
          api: 'local East-North-Up (metres)',
          renderer: '(X,Y,Z) = (East,Up,-North)',
        },
        scene: {
          anchor,
          featureCounts,
          featureCount: buildings.length,
          canonicalInputSha256: sceneInputSha256,
        },
        solver: {
          carrierFrequencyGhz: freqGhz,
          maxDepth,
          options: solverOptions,
          materials,
        },
        devices: { transmitters: txs, receivers: rxs },
        availableOutputs: {
          renderedPathCount: paths.length,
          radioMap: radioMap ? {
            cells: radioMap.cells.length,
            gridSizeM: radioMap.gridSize,
            heightOffsetM: radioMap.heightOffset,
            metric: radioMap.metric,
            samplesPerTx: radioMap.samplesPerTx,
            seed: radioMap.seed,
            stats: radioMap.stats,
          } : null,
        },
      };
      triggerDownload(
        `${JSON.stringify(manifest, null, 2)}\n`,
        'sionna_rt_studio_experiment_manifest.json',
        'application/json',
      );
    } finally {
      setManifestBusy(false);
    }
  };

  // Build the coverage-derived proxy from a received-power radio map.
  const handleExportCoverageGrid = () => {
    if (!radioMap) return;
    if (radioMap.metric && radioMap.metric !== 'power') {
      setChannelGridError(t('Coverage proxy requires a received-power map. Recompute Power coverage or select the ray-traced export.', "覆盖近似需要接收功率图。请重新计算功率覆盖或选择射线追踪导出。"));
      return;
    }
    const datasetStr = exportCoverageChannelGrid(tx, radioMap, channelGridConfig, freqGhz);
    triggerDownload(datasetStr, `sionna_rt_studio_coverage_proxy_${freqGhz}Ghz.json`, 'application/json');
  };

  // Ray-traced path: re-trace every radio-map cell on the backend and download
  // the full per-Rx/per-Tx-port CFR (paths.cfr()) as a NumPy .npz.
  const handleExportRayTracedGrid = async () => {
    if (!radioMap) return;
    setChannelGridError('');
    setChannelGridBusy(true);
    try {
      const cells = radioMap.cells.map((c) => ({ x: c.x, y: c.y, z: c.z }));
      // Map the UI's (subcarriers, bandwidth) to an OFDM subcarrier spacing.
      const numSubcarriers = Math.max(1, Math.round(channelGridConfig.numSubcarriers));
      const subcarrierSpacing = Math.max(1, (channelGridConfig.bandwidthMhz * 1e6) / numSubcarriers);
      const { blob, filename } = await exportChannelGrid(
        tx,
        rx,
        buildings,
        cells,
        freqGhz,
        maxDepth,
        solverOptions,
        { numSubcarriers, subcarrierSpacing, normalizeDelays: true },
        materials,
      );
      triggerDownload(blob, filename);
    } catch (err) {
      setChannelGridError(err instanceof Error ? err.message : t('Ray-traced CFR export failed', "射线追踪 CFR 导出失败"));
    } finally {
      setChannelGridBusy(false);
    }
  };

  // The export button branches on the toggle.
  const handleChannelGridClick = () => (rayTracedGrid ? handleExportRayTracedGrid() : handleExportCoverageGrid());
  // Over-cap grids are blocked up front (the backend would reject them anyway).
  const gridOverCap = rayTracedGrid && !!radioMap && radioMap.cells.length > CHANNEL_GRID_MAX_CELLS;
  const proxyNeedsPowerMap = !rayTracedGrid && !!radioMap && !!radioMap.metric && radioMap.metric !== 'power';

  // Re-runs the Sionna PathSolver on the backend and downloads the channel
  // impulse response (a, tau) / channel frequency response (h), like Python's
  // paths.cir() / paths.cfr().
  const handleExportCIR = async (format: CIRFormat) => {
    setCirError('');
    setCirBusy(format);
    try {
      const { blob, filename } = await exportCIR(
        tx,
        rx,
        buildings,
        freqGhz,
        maxDepth,
        solverOptions,
        format,
        csiGrid,
        materials,
        exportAllDevices ? { txs, rxs } : undefined,
      );
      triggerDownload(blob, filename);
    } catch (err) {
      setCirError(err instanceof Error ? err.message : t('CIR/CFR export failed', "CIR/CFR 导出失败"));
    } finally {
      setCirBusy(null);
    }
  };

  const handleExportCIRBundle = async () => {
    setCirError('');
    setCirBusy('bundle');
    try {
      const { blob, filename } = await exportCIRBundle(
        txs,
        rxs,
        buildings,
        freqGhz,
        maxDepth,
        solverOptions,
        normalizeDelays,
        materials,
      );
      triggerDownload(blob, filename);
    } catch (error) {
      setCirError(error instanceof Error ? error.message : t('All-pairs CIR bundle export failed', "全链路 CIR 压缩包导出失败"));
    } finally {
      setCirBusy(null);
    }
  };

  // Downloads the Mitsuba scene the backend traces, plus a generated
  // load_scene.py replaying the Python-side setup Sionna keeps out of the XML.
  const handleExportScene = async () => {
    setSceneError('');
    setSceneBusy(true);
    try {
      const { blob, filename } = await exportScene(
        txs,
        rxs,
        buildings,
        freqGhz,
        maxDepth,
        solverOptions,
        csiGrid,
        materials,
        anchor,
      );
      triggerDownload(blob, filename);
    } catch (error) {
      setSceneError(error instanceof Error ? error.message : t('Scene export failed', "场景导出失败"));
    } finally {
      setSceneBusy(false);
    }
  };

  const txArraysMatch = txs.every(
    (candidate) =>
      candidate.antennaArraySize[0] === txs[0]?.antennaArraySize[0] &&
      candidate.antennaArraySize[1] === txs[0]?.antennaArraySize[1],
  );
  const rxArraysMatch = rxs.every(
    (candidate) =>
      candidate.antennaArraySize[0] === rxs[0]?.antennaArraySize[0] &&
      candidate.antennaArraySize[1] === rxs[0]?.antennaArraySize[1],
  );
  const multiDeviceArraysMatch = txArraysMatch && rxArraysMatch;
  const numTxPorts = txs[0] ? antennaPortCount(txs[0].antennaArraySize, solverOptions.txPolarization) : 0;
  const numRxPorts = rxs[0] ? antennaPortCount(rxs[0].antennaArraySize, solverOptions.rxPolarization) : 0;
  const multiDeviceExportDisabled =
    exportAllDevices && (!multiDeviceArraysMatch || txs.length === 0 || rxs.length === 0);

  return (
    <div id="export-suite-panel" className="panel p-5 flex flex-col gap-6 h-full overflow-y-auto">
      {/* Title */}
      <div className="flex items-center gap-2 border-b border-[#e3e0d6] pb-3">
        <FileDown className="w-5 h-5 text-[#cc785c]" />
        <div>
          <h3 className="panel-title">{t("Research Data & Reproducibility Exports", "研究数据与复现实验导出")}</h3>
          <p className="text-[12px] text-[#6b6862] font-semibold">{t("Hash the scene inputs and export geometry, rays, and channel tensors", "生成场景输入哈希，导出几何、射线路径与信道张量")}</p>
        </div>
      </div>

      {/* Grid of exporter cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section id="csi-run-export-panel" className="md:col-span-2 flex flex-col gap-3 rounded border border-[var(--line)] bg-[#f5f3ec] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="panel-title flex items-center gap-2">
              <Waves className="w-4 h-4 text-[#4a727e]" aria-hidden="true" />
              {t('CSI from Preview', '本次预览的 CSI')}
            </h4>
            {csiRun && !csiStale && <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">{t('Ready', '可导出')}</span>}
          </div>
          {csiRun && (
            <div className="grid gap-2 text-xs text-slate-700 sm:grid-cols-2">
              <p>{csiRun.mode === 'static' ? t('Static all links', '静态全链路') : t('Selected UE trajectory', '所选 UE 轨迹')} · {csiRun.txIds.length} AP · {csiRun.rxIds.length} UE</p>
              <p>{t(`${csiRun.timeSeconds.length} samples`, `${csiRun.timeSeconds.length} 个时刻`)} · {csiRun.carrierFrequencyGhz} GHz · {csiRun.numSubcarriers} × {csiRun.subcarrierSpacing / 1e3} kHz</p>
              <p id="csi-export-output" className="sm:col-span-2">
                {csiRun.output === 'cir' ? t('CIR only', '仅 CIR') : t('CIR + full CFR', 'CIR + 完整 CFR')}
                {' · '}{formatCsiBytes(csiRun.uncompressedBytes)} {t('uncompressed', '未压缩')}
              </p>
              <p className="sm:col-span-2">
                {csiRun.output === 'cir' && <span>{t('Reconstructible CFR', '可重建的 CFR')} </span>}
                <span className="readout">H [{csiRun.shape.join(' × ')}]</span>{' '}
                <span className="text-slate-500">{t('Time · UE · Rx port · AP · Tx port · subcarrier', '时间 · UE · Rx 端口 · AP · Tx 端口 · 子载波')}</span>
              </p>
            </div>
          )}
          {(!csiRun || csiStale) && (
            <p role="status" className="text-xs text-slate-600">
              {csiStale ? t('Inputs have changed. Run Preview again before exporting.', '输入已变化，请重新计算预览后再导出。') : t('Generate a static or trajectory result in Preview to export CSI.', '请先在预览页计算静态全链路或 UE 轨迹。')}
            </p>
          )}
          {csiRun && !csiStale && (
            <p className="text-xs text-slate-600">
              {csiRun.output === 'cir' ? t(
                'The ZIP includes path coefficients, delays, valid paths, and the frequency grid in csi.npz. Use these arrays to reconstruct CFR. The manifest records current AP fronthaul settings.',
                'ZIP 的 csi.npz 包含路径复系数、时延、有效路径掩码和频率网格，可用于重建 CFR。清单记录当前 AP 前传配置。',
              ) : t('The ZIP includes the computed csi.npz and manifest.json with current AP fronthaul settings.', 'ZIP 包含本次计算的 csi.npz，以及记录当前 AP 前传配置的 manifest.json。')}
            </p>
          )}
          {csiError && csiError.runId === csiRun?.runId && <p role="alert" className="text-xs text-red-700">{csiError.message}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              id="btn-export-csi-run"
              type="button"
              onClick={handleExportCsiRun}
              disabled={!csiRun || csiStale || csiBusy}
              className="flex items-center gap-1.5 rounded bg-[var(--accent)] px-3 py-2 text-sm font-bold text-white hover:bg-[var(--accent-deep)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {csiBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
              {csiBusy ? t('Preparing ZIP…', '正在打包…') : csiRun?.output === 'cir'
                ? t('Download CIR + manifest (.zip)', '下载 CIR 与清单（.zip）')
                : t('Download CSI + manifest (.zip)', '下载 CSI 与清单（.zip）')}
            </button>
            {onOpenPreview && (!csiRun || csiStale || csiError?.runId === csiRun.runId) && (
              <button type="button" id="btn-return-to-preview" onClick={onOpenPreview} className="rounded border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:border-[var(--accent)]">
                {t('Go to Preview', '前往预览')}
              </button>
            )}
          </div>
        </section>

        {/* Project session. Studio state rather than a research artifact, so it
            reads as a control strip and stays above the exports — save, restore,
            and reset are what people reach for first. */}
        <div className="md:col-span-2 bg-[#f5f3ec] px-4 py-3 rounded border border-[#e3e0d6] flex flex-col gap-2 shadow-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Save className="w-4 h-4 text-[#cc785c] shrink-0" />
            <h4 className="panel-title">{t("Project Session", "项目会话")}</h4>
            <span className={`text-[11px] px-2 py-0.5 rounded font-mono font-bold border whitespace-nowrap ${
                  autosaveStatus === 'saved'
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : autosaveStatus === 'saving'
                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'bg-red-50 text-red-700 border-red-200'
            }`}>
              {autosaveStatus === 'saved' ? t('Autosaved locally', "已自动保存到本机")
                : autosaveStatus === 'saving' ? t('Autosaving…', "正在自动保存…")
                : autosaveStatus === 'disabled' ? t('Autosave unavailable', "自动保存不可用")
                : t('Autosave failed', "自动保存失败")}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button
                id="btn-export-project"
                onClick={handleExportProject}
                className="bg-[#cc785c] hover:bg-[#b2624a] text-white text-[14px] font-bold py-1.5 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-transparent"
              >
                <FileDown className="w-4 h-4" />
                {t("Export Project", "导出项目")}
              </button>
              <button
                id="btn-import-project"
                onClick={() => projectFileRef.current?.click()}
                className="bg-white hover:border-[#cc785c] text-slate-700 text-[14px] font-bold py-1.5 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#ddd9cb]"
              >
                <FileUp className="w-4 h-4" />
                {t("Import Project", "导入项目")}
              </button>
              <button
                id="btn-reset-project"
                onClick={onResetProject}
                title={t("Discard the autosaved project and return the studio to its defaults", "丢弃自动保存的项目并恢复默认设置")}
                className="bg-white hover:bg-red-50 hover:border-red-300 text-[#b4483c] text-[14px] font-bold py-1.5 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[var(--line)]"
              >
                <RotateCcw className="w-4 h-4" />
                {t("Reset Studio", "重置实验台")}
              </button>
              <input
                ref={projectFileRef}
                type="file"
                accept=".json,application/json"
                onChange={handleImportProjectFile}
                className="hidden"
                aria-label={t("Import SionnaRTStudio project JSON", "导入 SionnaRTStudio 项目 JSON")}
              />
            </div>
          </div>
          <p className="text-[12px] text-slate-600 leading-relaxed">
            {t(
              'Autosaves scene geometry, every Tx/Rx and antenna setting, solver and material controls, trajectory, coverage controls, and display choices. Ray paths, maps, matrices, and mobility results are recomputed after loading.',
              '自动保存场景几何、收发端与天线设置、求解器与材质、轨迹、覆盖参数和显示选项。载入后可重新计算射线路径、覆盖图、链路矩阵和移动结果。',
            )}
          </p>
          {projectMessage && (
            <div className={`text-[12px] rounded px-2.5 py-1.5 font-semibold border ${
              projectMessage.kind === 'success'
                ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                : 'text-red-700 bg-red-50 border-red-200'
            }`}>
              {t(...projectMessage.text)}
            </div>
          )}
        </div>

        <details className="md:col-span-2 rounded border border-[var(--line)] p-3">
          <summary className="cursor-pointer px-1 py-1 text-sm font-semibold text-slate-800">{t('Advanced exports', '高级导出')}</summary>
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
        <SectionHeading
          title={t("Additional channel data", "其他信道数据")}
          hint={t("Independent CIR/CFR and grid experiments", "独立的 CIR/CFR 和栅格实验")}
        />
        <div className="md:col-span-2 bg-[#f5f3ec] p-5 rounded border border-[#e3e0d6] flex flex-col gap-4 shadow-md hover:border-[#cc785c]/40 transition duration-240">
          <div className="flex items-start justify-between">
            <div className="p-3 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#141413] shadow-inner">
              <Waves className="w-6 h-6 text-[#7b6b93]" />
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200">
               {t("CHANNEL RESPONSE (.npz / .csv)", "信道响应（.npz / .csv）")}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h4 className="panel-title">{t("CIR & CFR Export (paths.cir / paths.cfr)", "CIR 与 CFR 导出（paths.cir / paths.cfr）")}</h4>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              {t('Re-runs the Sionna RT ', '重新运行 Sionna RT ')}
              <code className="text-[12px] bg-slate-200 px-1 rounded">PathSolver</code>
              {t(' and exports the native channel tensors. Raw CIR returns exactly ', ' 并导出原始信道张量。原始 CIR 对应 ')}
              <code className="text-[12px] bg-slate-200 px-1 rounded">a, tau = paths.cir()</code>
              {t('; the combined NPZ also evaluates ', '。合并 NPZ 还会计算 ')}
              <code className="text-[12px] bg-slate-200 px-1 rounded">paths.cfr()</code>
              {t(' over the OFDM grid.', ' 在 OFDM 栅格上的输出。')}
            </p>
          </div>

          <label className="flex items-start gap-2.5 bg-white border border-[#ddd9cb] rounded p-3 cursor-pointer">
            <input
              id="chk-export-all-cir-devices"
              type="checkbox"
              checked={exportAllDevices}
              onChange={(event) => {
                setExportAllDevices(event.target.checked);
                setCirError('');
              }}
              className="mt-0.5 accent-[var(--accent)] cursor-pointer"
            />
            <span className="flex flex-col gap-1">
              <span className="text-[12px] font-bold text-slate-800">
                {t("Export all Tx × Rx as one scene tensor", "将所有收发端组合导出为一个场景张量")}
              </span>
              <span className="text-[11px] text-slate-600 leading-relaxed">
                {exportAllDevices
                  ? `${t('Expected', '预期形状')} a: [${rxs.length}, ${numRxPorts}, ${txs.length}, ${numTxPorts}, paths, 1] · tau: [${rxs.length}, ${numRxPorts}, ${txs.length}, ${numTxPorts}, paths] · ${t('NPZ only', '仅 NPZ')}`
                  : t(`Off: export active ${tx.name} → ${rx.name} only.`, `关闭时仅导出当前链路 ${tx.name} → ${rx.name}。`)}
              </span>
            </span>
          </label>
          {exportAllDevices && !multiDeviceArraysMatch && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-[#f8f1ec] border border-[#dcb79a] rounded p-3">
              <div className="flex items-start gap-1.5 text-[#94503c] text-[12px] font-semibold flex-1">
                <AlertOctagon className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {t("A single dense scene tensor requires uniform arrays. Keep your heterogeneous arrays and export an exact per-pair ZIP instead.", "单个稠密场景张量要求阵列配置一致。阵列配置各异时，可将每条链路的原始数据分别导出到一个 ZIP。")}
                </span>
              </div>
              <button
                id="btn-export-cir-bundle"
                onClick={handleExportCIRBundle}
                disabled={cirBusy !== null || txs.length === 0 || rxs.length === 0}
                className="shrink-0 bg-[#94503c] hover:bg-[#7a4232] disabled:bg-slate-200 disabled:text-slate-400 text-white text-[12px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border-0 disabled:cursor-not-allowed"
                title={t(
                  `Retraces ${txs.length * rxs.length} links and downloads one manifest plus one raw-CIR NPZ per pair.`,
                  `重新追踪 ${txs.length * rxs.length} 条链路并下载清单及每条链路的原始 CIR NPZ。`,
                )}
              >
                {cirBusy === 'bundle' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                {cirBusy === 'bundle' ? t(`Tracing ${txs.length * rxs.length} pairs…`, `正在追踪 ${txs.length * rxs.length} 条链路…`) : t('Export all-pairs ZIP', '导出全链路 ZIP')}
              </button>
            </div>
          )}

          <p className="rounded border border-[var(--line)] bg-white px-3 py-2 text-xs text-slate-700">
            {t('Scene OFDM settings', '场景 OFDM 设置')} · {numSubcarriers} × {subcarrierSpacing / 1e3} kHz · {normalizeDelays ? t('Normalized delay', '归一化时延') : t('Absolute delay', '绝对时延')}
          </p>

          {cirError && (
            <div className="flex items-center gap-1.5 bg-[#f9efec] border border-[#d9aaa2] text-[#b4483c] rounded py-1.5 px-3 text-[12px] font-semibold">
              <AlertOctagon className="w-3.5 h-3.5" />
              {cirError}
            </div>
          )}

          <div className="mt-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            <button
              id="btn-export-raw-cir-npz"
              onClick={() => handleExportCIR('cir_npz')}
              disabled={paths.length === 0 || cirBusy !== null || multiDeviceExportDisabled}
              className="bg-[var(--accent)] hover:bg-[var(--accent-deep)] disabled:bg-slate-100 disabled:text-slate-400 text-white text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-transparent disabled:cursor-not-allowed"
            >
              {cirBusy === 'cir_npz' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
              {t("Raw a, tau (.npz)", "原始 a、tau（.npz）")}
            </button>
            <button
              id="btn-export-cir-npz"
              onClick={() => handleExportCIR('npz')}
              disabled={paths.length === 0 || cirBusy !== null || multiDeviceExportDisabled}
              className="bg-[#ebe7dc] hover:bg-[var(--accent)] hover:text-white disabled:bg-slate-100 disabled:text-slate-400 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent disabled:cursor-not-allowed"
            >
              {cirBusy === 'npz' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
              a, tau, h (.npz)
            </button>
            <button
              id="btn-export-cir-csv"
              onClick={() => handleExportCIR('cir_csv')}
              disabled={paths.length === 0 || cirBusy !== null || exportAllDevices}
              title={exportAllDevices ? t('CSV supports one Tx→Rx link; use NPZ for the multi-device tensor.', "CSV 仅支持单条链路。多设备张量请用 NPZ。") : undefined}
              className="bg-[#ebe7dc] hover:bg-[var(--accent)] hover:text-white disabled:bg-slate-100 disabled:text-slate-400 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent disabled:cursor-not-allowed"
            >
              {cirBusy === 'cir_csv' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
              CIR (.csv)
            </button>
            <button
              id="btn-export-cfr-csv"
              onClick={() => handleExportCIR('cfr_csv')}
              disabled={paths.length === 0 || cirBusy !== null || exportAllDevices}
              title={exportAllDevices ? t('CSV supports one Tx→Rx link; use NPZ for the multi-device tensor.', "CSV 仅支持单条链路。多设备张量请用 NPZ。") : undefined}
              className="bg-[#ebe7dc] hover:bg-[var(--accent)] hover:text-white disabled:bg-slate-100 disabled:text-slate-400 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent disabled:cursor-not-allowed"
            >
              {cirBusy === 'cfr_csv' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
              CFR (.csv)
            </button>
          </div>
          {paths.length === 0 && (
            <p className="text-[11px] text-slate-500 font-medium leading-normal -mt-1">
              {t("To enable these CIR/CFR formats, solve a link under Advanced static link analysis in Preview.", "如需使用这些 CIR/CFR 格式，请先在预览页的「高级静态链路分析」中计算一条链路。")}
            </p>
          )}
        </div>

        {/* Grid-sampled dataset: coverage proxy, or per-cell ray-traced MIMO CFR. */}
        <div className="md:col-span-2 bg-[#f5f3ec] p-5 rounded border border-[#e3e0d6] flex flex-col gap-4 shadow-md hover:border-[#cc785c]/40 transition duration-240">
          <div className="flex items-start justify-between">
            <div className="p-3 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#141413] shadow-inner">
              <Database className="w-6 h-6 text-[#4a727e]" />
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200">
               {rayTracedGrid ? t('RAY-TRACED (.npz)', "射线追踪（.npz）") : t('COVERAGE PROXY (.json)', "覆盖近似（.json）")}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h4 className="panel-title">{t("Channel Grid Dataset", "栅格信道数据集")}</h4>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              {t('Per-cell dataset over the computed radio map. ', '基于覆盖图生成逐栅格数据。')}
              <strong>{t('Synthetic', '合成近似')}</strong>
              {t(" (default): each cell's ", '（默认）使用各栅格的 ')}
              <code className="text-[12px] bg-slate-200 px-1 rounded">H</code>
              {t(
                ' magnitude comes from its coverage power with a deterministic phase — instant, in-browser JSON. ',
                ' 幅值由覆盖功率换算，并赋予确定相位。可即时生成 JSON。',
              )}
              <strong>{t('Ray-traced', '射线追踪')}</strong>
              {t(': re-traces every cell and exports the genuine ', '逐格追踪射线，将真实的 ')}
              <code className="text-[12px] bg-slate-200 px-1 rounded">paths.cfr()</code>
              {t(' channel as ', ' 信道数据导出为 ')}
              <code className="text-[12px] bg-slate-200 px-1 rounded">.npz</code>
              {t(', preserving the active Tx and Rx array-port axes.', '，保留当前收发端的阵列端口维度。')}
            </p>
          </div>

          {/* Export-mode toggle: synthetic (default) vs per-cell ray tracing. */}
          <div className="flex items-center justify-between gap-3 bg-white border border-[#e3e0d6] rounded px-3 py-2">
            <div className="flex flex-col">
              <span className="text-[12px] font-bold text-slate-800">{t("Ray-Traced Per-Element CFR", "逐天线单元的射线追踪 CFR")}</span>
              <span className="text-[11px] text-slate-500">{rayTracedGrid ? t('paths.cfr() per cell — backend, slow', "逐格运行 paths.cfr()，由后端计算") : t('Coverage-derived proxy — instant', "覆盖图近似，即时生成")}</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={rayTracedGrid}
              onClick={() => setRayTracedGrid(!rayTracedGrid)}
              className={`relative w-10 h-5 rounded-full transition shrink-0 cursor-pointer ${rayTracedGrid ? 'bg-[var(--accent)]' : 'bg-slate-300'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${rayTracedGrid ? 'translate-x-5' : ''}`} />
            </button>
          </div>

          {/* OFDM grid configuration */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-bold text-slate-600">{t("Subcarriers", "子载波数")}</span>
              <NumberField
                integer
                min={1}
                max={8192}
                value={channelGridConfig.numSubcarriers}
                onChange={(numSubcarriers) => setChannelGridConfig({ ...channelGridConfig, numSubcarriers })}
                className="bg-white border border-[#e3e0d6] rounded px-2 py-1.5 text-[14px] text-slate-900 focus:border-[#4a727e] focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-bold text-slate-600">{t("Bandwidth (MHz)", "带宽（MHz）")}</span>
              <NumberField
                integer
                min={1}
                max={2000}
                value={channelGridConfig.bandwidthMhz}
                onChange={(bandwidthMhz) => setChannelGridConfig({ ...channelGridConfig, bandwidthMhz })}
                className="bg-white border border-[#e3e0d6] rounded px-2 py-1.5 text-[14px] text-slate-900 focus:border-[#4a727e] focus:outline-none"
              />
            </label>
          </div>

          {!radioMap && (
            <div className="flex items-center gap-1.5 bg-[#f8f1ec] border border-[#dcb79a] text-[#cc785c] rounded py-1.5 px-3 text-[12px] font-semibold">
              <AlertOctagon className="w-3.5 h-3.5" />
              {t("Compute a Radio Coverage grid first (Radio Coverage tab) to enable this export.", "请先在无线覆盖标签页计算覆盖栅格。")}
            </div>
          )}

          {proxyNeedsPowerMap && (
            <div className="flex items-start gap-1.5 bg-[#f8f1ec] border border-[#dcb79a] text-[#6f5624] rounded py-1.5 px-3 text-[12px] font-semibold">
              <AlertOctagon className="w-3.5 h-3.5 mt-px shrink-0" />
              <span>{t("The JSON proxy requires a received-power radio map; SINR is not a channel magnitude. Recompute Power coverage or enable ray-traced CFR.", "JSON 近似需要接收功率覆盖图。请重新计算功率覆盖，或启用射线追踪 CFR。")}</span>
            </div>
          )}

          {rayTracedGrid && radioMap && (
            <div className="flex items-start gap-1.5 bg-[#f8f1ec] border border-[#dcb79a] text-[#6f5624] rounded py-1.5 px-3 text-[12px] font-semibold">
              <AlertOctagon className="w-3.5 h-3.5 mt-px shrink-0" />
              <span>
                {t("Ray-traces all ", "后端将追踪全部 ")}{radioMap.cells.length}{t(" cells on the backend — this can take a while.", " 个栅格，可能需要一些时间。")}
                {gridOverCap && t(
                  ` Exceeds the ${CHANNEL_GRID_MAX_CELLS}-cell cap; recompute coverage with a coarser grid size.`,
                  ` 当前超过 ${CHANNEL_GRID_MAX_CELLS} 个栅格的上限，请增大栅格间距后重新计算覆盖。`,
                )}
              </span>
            </div>
          )}

          {channelGridError && (
            <div className="flex items-center gap-1.5 bg-red-50 border border-red-300 text-red-700 rounded py-1.5 px-3 text-[12px] font-semibold">
              <AlertOctagon className="w-3.5 h-3.5 shrink-0" />
              {channelGridError}
            </div>
          )}

          <button
            id="btn-export-channel-grid"
            onClick={handleChannelGridClick}
            disabled={!radioMap || channelGridBusy || gridOverCap || proxyNeedsPowerMap}
            className="mt-auto w-full bg-[#ebe7dc] hover:bg-[var(--accent)] hover:text-white disabled:bg-slate-100 disabled:text-slate-400 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent disabled:cursor-not-allowed"
          >
            {channelGridBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            {channelGridBusy ? t('Ray-Tracing Cells…', "正在追踪栅格…") : rayTracedGrid ? t('Download Ray-Traced CFR (NPZ)', "下载射线追踪 CFR（NPZ）") : t('Download Coverage Proxy (JSON)', "下载覆盖近似（JSON）")}
          </button>
        </div>
        <SectionHeading
          title={t("Reproducibility", "可复现性")}
          hint={t("Rerun this experiment elsewhere, or record exactly how it ran", "记录实验配置，便于在其他环境复现")}
        />
        {/* The traced Mitsuba scene itself, runnable without the app. */}
        <div className="md:col-span-2 bg-[#f5f3ec] p-5 rounded border border-[#e3e0d6] flex flex-col gap-4 shadow-md hover:border-[#cc785c]/40 transition duration-240">
          <div className="flex items-start justify-between">
            <div className="p-3 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#141413] shadow-inner">
              <Package className="w-6 h-6 text-[#4a727e]" />
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200">
               {t("STANDALONE SIONNA RT SCENE (.zip)", "独立 SIONNA RT 场景（.zip）")}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h4 className="panel-title">{t("Sionna RT Scene Export (load_scene)", "Sionna RT 场景导出（load_scene）")}</h4>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              {t('Downloads the exact Mitsuba scene this backend ray-traces — ', '下载后端用于射线追踪的 Mitsuba 场景，包括 ')}
              <code className="text-[12px] bg-slate-200 px-1 rounded">scene.xml</code>
              {t(' with ITU radio-material BSDFs plus one ', '（含 ITU 无线材质 BSDF）和每栋楼的 ')}
              <code className="text-[12px] bg-slate-200 px-1 rounded">.ply</code>
              {t(' per building — alongside a generated ', ' 网格，以及自动生成的 ')}
              <code className="text-[12px] bg-slate-200 px-1 rounded">load_scene.py</code>
              {t(
                '. The script replays what Sionna keeps in Python rather than in the XML: carrier frequency, material overrides, the ',
                '。脚本复现 Python 侧的载频、材质覆盖、',
              )}
              <code className="text-[12px] bg-slate-200 px-1 rounded">PlanarArray</code>
              {t(' config, every Tx/Rx, and the ', ' 阵列配置、全部收发端和 ')}
              <code className="text-[12px] bg-slate-200 px-1 rounded">PathSolver</code>
              {t(' switches — ending in ', ' 求解器开关，最后运行 ')}
              <code className="text-[12px] bg-slate-200 px-1 rounded">paths.cir()</code>{' / '}
              <code className="text-[12px] bg-slate-200 px-1 rounded">paths.cfr()</code>
              {t('. Run it in a plain notebook with no app in the loop.', '。脚本可直接在 Notebook 中运行。')}
            </p>
          </div>

          <p className="text-[11px] text-slate-500 font-medium leading-normal">
            {t(
              'Uses the OFDM grid and delay-normalization settings above. Uniform arrays make the generated script write one dense ',
              '沿用上述 OFDM 栅格和时延归一化配置。阵列一致时，脚本生成一个稠密的 ',
            )}
            <code className="text-[11px] bg-slate-200 px-1 rounded">cir.npz</code>
            {t('. For mixed arrays, the script writes exact antenna-compatible tensors under', '。阵列各异时，脚本在以下目录按链路生成对应的信道张量')}
            <code className="text-[11px] bg-slate-200 px-1 rounded ml-1">channels/</code>
            {t(', together covering every Tx × Rx pair.', '，覆盖所有收发端组合。')}
          </p>

          {sceneError && (
            <div className="flex items-center gap-1.5 bg-[#f9efec] border border-[#d9aaa2] text-[#b4483c] rounded py-1.5 px-3 text-[12px] font-semibold">
              <AlertOctagon className="w-3.5 h-3.5" />
              {sceneError}
            </div>
          )}

          <button
            id="btn-export-sionna-scene"
            onClick={handleExportScene}
            disabled={sceneBusy}
            className="mt-auto w-full bg-[var(--accent)] hover:bg-[var(--accent-deep)] disabled:bg-slate-100 disabled:text-slate-400 text-white text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-transparent disabled:cursor-not-allowed"
          >
            {sceneBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            {sceneBusy ? t('Building scene…', "正在构建场景…") : t('Scene + load_scene.py (.zip)', "场景和 load_scene.py（.zip）")}
          </button>

        </div>

        {/* Reproduction manifest: concise inputs/provenance, not a result surrogate. */}
        <div className="bg-[#f5f3ec] p-5 rounded border border-[#e3e0d6] flex flex-col gap-4 shadow-md hover:border-[#cc785c]/40 transition duration-240">
          <div className="flex items-start justify-between">
            <div className="p-3 bg-[#ebe7dc] border border-[#e3e0d6] rounded shadow-inner">
              <Fingerprint className="w-6 h-6 text-[#cc785c]" />
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded font-mono font-bold bg-[#ebe7dc] text-slate-600 border border-[#e3e0d6]">
               {t("PROVENANCE (.json)", "实验来源记录（.json）")}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h4 className="panel-title">{t("Experiment Reproduction Manifest", "实验复现清单")}</h4>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              {t(
                'Records every transmitter and receiver, solver flags, path-sampling seed and budget, material overrides, coordinate convention, radio-map controls, and a SHA-256 digest of the canonical scene input. Export the matching GeoJSON or OBJ beside it to preserve the geometry.',
                '记录收发端、求解器开关、射线采样种子和预算、材质覆盖、坐标约定、覆盖设置及标准化场景输入的 SHA-256 摘要。可同时导出对应的 GeoJSON 或 OBJ 来保存几何。',
              )}
            </p>
          </div>
          <button
            id="btn-export-experiment-manifest"
            onClick={handleExportManifest}
            disabled={manifestBusy || buildings.length === 0}
            className="mt-auto w-full bg-[#ebe7dc] hover:bg-[#cc785c] hover:text-white disabled:bg-slate-100 disabled:text-slate-400 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent disabled:cursor-not-allowed"
          >
            {manifestBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            {t("Download Manifest (.json)", "下载复现清单（.json）")}
          </button>
        </div>

        {/* Per-path record of the current solve, readable in a spreadsheet. */}
        <div className="bg-[#f5f3ec] p-5 rounded border border-[#e3e0d6] flex flex-col gap-4 shadow-md hover:border-[#cc785c]/40 transition duration-240">
          <div className="flex items-start justify-between">
            <div className="p-3 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#141413] shadow-inner">
              <FileSpreadsheet className="w-6 h-6 text-[#5f7f5a]" />
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200">
               {t("SPREADSHEET SPREAD (.csv)", "表格数据（.csv）")}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h4 className="panel-title">{t("Propagation Path Rays Report", "传播路径报告")}</h4>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              {t("Export computed propagation reflection parameters. Mapped values include specific path identifier names, order indices (LOS/Reflection orders), total distance metric, power levels (dBm), delays (ns), and coordinates.", "导出路径标识、视距或反射阶次、总距离、功率（dBm）、时延（ns）和坐标。")}
            </p>
          </div>

          <button
            id="btn-export-rays-csv"
            onClick={handleExportCSV}
            disabled={paths.length === 0}
            className="mt-auto w-full bg-[#ebe7dc] hover:bg-[#cc785c] hover:text-white disabled:bg-slate-100 disabled:text-slate-700 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent"
          >
            <FileDown className="w-4 h-4" />
            {t("Download Propagation CSV", "下载传播路径 CSV")}
          </button>
        </div>

          </div>
        </details>

        <SectionHeading
          title={t("Scene geometry", "场景几何")}
          hint={t("The 3D twin and its footprints, for other tools", "导出三维场景和建筑轮廓供其他工具使用")}
        />
        {/* Extruded 3D twin for Blender / Unity / CAD. */}
        <div className="bg-[#f5f3ec] p-5 rounded border border-[#e3e0d6] flex flex-col gap-4 shadow-md hover:border-[#cc785c]/40 transition duration-240">
          <div className="flex items-start justify-between">
            <div className="p-3 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#141413] shadow-inner">
              <Box className="w-6 h-6 text-[#cc785c]" />
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200">
               {t("3D MESH MODEL (.obj)", "三维网格（.obj）")}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h4 className="panel-title">{t("Wavefront 3D OBJ Export", "Wavefront 三维 OBJ 导出")}</h4>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              {t("Export the procedurally extruded 3D twin (including building shapes, heights, streets, vegetation, and waterways) as standard Wavefront OBJ vertices and face indices, fully compatible with Blender, Unity, and CAD.", "将建筑形状与高度、道路、植被、水域等几何导出为标准 Wavefront OBJ 顶点和面索引，可在 Blender、Unity 和 CAD 工具中打开。")}
            </p>
          </div>

          <button
            id="btn-export-mesh-obj"
            onClick={handleExportOBJ}
            disabled={buildings.length === 0}
            className="mt-auto w-full bg-[#ebe7dc] hover:bg-[#cc785c] hover:text-white disabled:bg-slate-100 disabled:text-slate-700 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent"
          >
            <FileDown className="w-4 h-4" />
            {t("Download 3D OBJ Model", "下载三维 OBJ 模型")}
          </button>
        </div>

        {/* Footprint polygons and tags for GIS tools. */}
        <div className="bg-[#f5f3ec] p-5 rounded border border-[#e3e0d6] flex flex-col gap-4 shadow-md hover:border-[#cc785c]/40 transition duration-240">
          <div className="flex items-start justify-between">
            <div className="p-3 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#141413] shadow-inner">
              <Compass className="w-6 h-6 text-[#4a727e]" />
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200">
               {t("GEOGRAPHIC VECTOR (.geojson)", "地理矢量（.geojson）")}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h4 className="panel-title">{t("GeoJSON Footprint Features", "GeoJSON 地理要素")}</h4>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              {t("Compile active coordinate anchor boundaries, physical building footprint polygons, material property metadata tags, structures levels, and highway vector coordinates as standard vector GeoJSON coordinates.", "将场景边界、建筑轮廓、材质元数据、楼层和道路等导出为标准 GeoJSON 矢量数据。")}
            </p>
          </div>

          <button
            id="btn-export-gis-geojson"
            onClick={handleExportGeoJSON}
            disabled={buildings.length === 0}
            className="mt-auto w-full bg-[#ebe7dc] hover:bg-[#cc785c] hover:text-white disabled:bg-slate-100 disabled:text-slate-700 text-slate-700 text-[14px] font-bold py-2 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer border border-[#e3e0d6] hover:border-transparent"
          >
            <FileDown className="w-4 h-4" />
            {t("Download GeoJSON Footprints", "下载 GeoJSON 轮廓")}
          </button>
        </div>

      </div>
    </div>
  );
}
