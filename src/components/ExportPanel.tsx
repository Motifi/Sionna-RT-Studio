/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, FileDown, Loader2 } from 'lucide-react';
import { ApiRequestError, exportCsiRun, exportScene, readBackendHealth, type CIRExportOptions, type CsiRun } from '../api';
import { useI18n } from '../i18n';
import { formatCsiBytes } from '../lib/csiSize';
import type {
  BuildingFootprint, ChannelGridConfig, GeoAnchor, MaterialConfig, PropagationPath,
  RadioMapGrid, Receiver, SolverOptions, Transmitter,
} from '../types';
import { exportCoverageChannelGrid, exportGeoJSON, exportOBJ3D, exportPropagationCSV } from '../utils';
import { downloadFile } from './downloadFile';
import { GridFrequencyFields } from './GridFrequencyFields';

const DEFAULT_CSI_GRID: CIRExportOptions = { numSubcarriers: 1024, subcarrierSpacing: 30_000, normalizeDelays: true };
const quietButton = 'btn-quiet flex cursor-pointer items-center justify-center gap-1.5 px-3 py-2 text-sm disabled:cursor-not-allowed';

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
  backendOnline: boolean;
  csiRun?: CsiRun | null;
  csiStale?: boolean;
  csiExpired?: boolean;
  csiGrid?: CIRExportOptions;
  fronthaulMbpsByTxId?: Record<string, number | null>;
  onOpenPreview?: () => void;
  onOpenDiagnostics: () => void;
  onOpenCoverage: () => void;
  onCsiExpired?: (runId: string) => void;
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

export function ExportPanel({
  buildings, anchor, paths, txs, rxs, tx, freqGhz, maxDepth, solverOptions, radioMap, materials, backendOnline,
  csiRun = null, csiStale = false, csiExpired = false, csiGrid = DEFAULT_CSI_GRID, fronthaulMbpsByTxId = {},
  onOpenPreview, onOpenDiagnostics, onOpenCoverage, onCsiExpired,
}: ExportPanelProps) {
  const { t } = useI18n();
  const [expiredRunId, setExpiredRunId] = useState<string | null>(null);
  const expired = csiExpired || (csiRun !== null && csiRun.runId === expiredRunId);
  const exportableRunId = csiStale || expired ? null : csiRun?.runId ?? null;
  const csiRequest = useRef<symbol | null>(null);
  const [csiBusy, setCsiBusy] = useState(false);
  const [csiError, setCsiError] = useState<{ runId: string; message: string } | null>(null);
  const [sceneBusy, setSceneBusy] = useState(false);
  const [sceneError, setSceneError] = useState('');
  const [manifestBusy, setManifestBusy] = useState(false);
  const [manifestError, setManifestError] = useState('');
  const [proxyGrid, setProxyGrid] = useState<ChannelGridConfig>({ numSubcarriers: 64, bandwidthMhz: 100 });
  const [proxyError, setProxyError] = useState('');
  const powerGrid = radioMap?.cells.length && (radioMap.metric ?? 'power') === 'power' ? radioMap : null;

  useLayoutEffect(() => {
    setCsiBusy(false);
    return () => { csiRequest.current = null; };
  }, [exportableRunId]);

  const handleExportCsiRun = async () => {
    if (!csiRun || !exportableRunId || !backendOnline || csiRequest.current) return;
    const request = Symbol();
    csiRequest.current = request;
    setCsiBusy(true);
    setCsiError(null);
    try {
      const fronthaul = Object.fromEntries(csiRun.txIds.map((id) => [id, fronthaulMbpsByTxId[id] ?? null]));
      const { blob, filename } = await exportCsiRun(exportableRunId, fronthaul);
      if (csiRequest.current === request) downloadFile(blob, filename);
    } catch (error) {
      if (csiRequest.current !== request) return;
      if (error instanceof ApiRequestError && error.status === 404) {
        setExpiredRunId(exportableRunId);
        onCsiExpired?.(exportableRunId);
      } else {
        setCsiError({
          runId: exportableRunId,
          message: error instanceof Error ? error.message : t('CSI download failed.', 'CSI 下载失败。'),
        });
      }
    } finally {
      if (csiRequest.current === request) {
        csiRequest.current = null;
        setCsiBusy(false);
      }
    }
  };

  const handleExportManifest = async () => {
    setManifestBusy(true);
    setManifestError('');
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
      downloadFile(
        `${JSON.stringify(manifest, null, 2)}\n`,
        'sionna_rt_studio_experiment_manifest.json',
        'application/json',
      );
    } catch (error) {
      setManifestError(error instanceof Error ? error.message : t('Manifest export failed.', '实验清单导出失败。'));
    } finally {
      setManifestBusy(false);
    }
  };

  const handleExportScene = async () => {
    setSceneBusy(true);
    setSceneError('');
    try {
      const { blob, filename } = await exportScene(txs, rxs, buildings, freqGhz, maxDepth, solverOptions, csiGrid, materials, anchor);
      downloadFile(blob, filename);
    } catch (error) {
      setSceneError(error instanceof Error ? error.message : t('Scene export failed.', '场景导出失败。'));
    } finally {
      setSceneBusy(false);
    }
  };

  const handleExportCoverageProxy = () => {
    if (!powerGrid) return;
    setProxyError('');
    try {
      downloadFile(
        exportCoverageChannelGrid(tx, powerGrid, proxyGrid, freqGhz),
        `sionna_rt_studio_coverage_proxy_${freqGhz}Ghz.json`,
        'application/json',
      );
    } catch (error) {
      setProxyError(error instanceof Error ? error.message : t('Coverage proxy export failed.', '覆盖近似导出失败。'));
    }
  };

  const additionalFiles = [
    {
      id: 'btn-export-sionna-scene', title: t('Standalone Sionna RT scene', '独立 Sionna RT 场景'),
      description: t('Mitsuba XML, meshes, and load_scene.py for replay in Python.', 'Mitsuba XML、网格和用于在 Python 中复现实验的 load_scene.py。'),
      format: '.zip', onClick: handleExportScene, disabled: sceneBusy, busy: sceneBusy, error: sceneError,
    },
    {
      id: 'btn-export-experiment-manifest', title: t('Experiment manifest', '实验复现清单'),
      description: t('Scene hash, devices, solver settings, materials, and coverage parameters.', '场景哈希、设备、求解参数、材质和覆盖参数。'),
      format: '.json', onClick: handleExportManifest, disabled: manifestBusy || buildings.length === 0,
      busy: manifestBusy, error: manifestError,
    },
    {
      id: 'btn-export-rays-csv', title: t('Propagation paths', '传播路径'),
      description: t('Computed path coordinates, distances, powers, and delays.', '已计算路径的坐标、距离、功率和时延。'),
      format: '.csv', disabled: paths.length === 0,
      onClick: () => downloadFile(exportPropagationCSV(paths), 'sionna_rt_studio_multipath_rays_report.csv', 'text/csv'),
    },
    {
      id: 'btn-export-mesh-obj', title: t('Scene mesh', '场景网格'),
      description: t('Wavefront geometry for 3D editors.', '用于三维编辑工具的 Wavefront 几何。'),
      format: '.obj', disabled: buildings.length === 0,
      onClick: () => downloadFile(exportOBJ3D(buildings), 'sionna_rt_studio_twin_model.obj', 'text/plain'),
    },
    {
      id: 'btn-export-gis-geojson', title: t('Geographic features', '地理要素'),
      description: t('Footprints and feature attributes for GIS tools.', '用于 GIS 工具的轮廓和地理要素属性。'),
      format: '.geojson', disabled: buildings.length === 0,
      onClick: () => downloadFile(exportGeoJSON(buildings, anchor), 'sionna_rt_studio_building_footprints.geojson', 'application/json'),
    },
  ];
  const currentCsiError = exportableRunId === csiError?.runId ? csiError.message : '';
  const csiStatus = expired
    ? t('This CSI run has expired. Recalculate it in Simulation.', '本次 CSI 运行已过期，请在仿真页重新计算。')
    : csiStale
      ? t('Inputs have changed. Recalculate CSI in Simulation.', '输入已变化，请在仿真页重新计算 CSI。')
      : !csiRun
        ? t('Calculate static or trajectory CSI in Simulation to download a ZIP.', '请先在仿真页计算静态或轨迹 CSI，再下载 ZIP。')
        : backendOnline ? t('Ready to download', '可下载')
          : t('Solver offline. Reconnect to download CSI.', '求解器离线，恢复连接后可下载 CSI。');

  return (
    <div id="export-suite-panel" className="panel mx-auto grid max-w-5xl gap-4 p-4 sm:p-5">
      <h1 className="panel-title">{t('Export results', '导出结果')}</h1>
      <section id="csi-run-export-panel" className="panel-flush grid gap-3 p-4" aria-labelledby="csi-export-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="csi-export-heading" className="panel-title">{t('CSI from this run', '本次运行的 CSI')}</h2>
          <p role="status" className={`text-xs font-semibold ${exportableRunId && backendOnline ? 'text-[var(--ok)]' : 'text-[var(--text-mid)]'}`}>{csiStatus}</p>
        </div>
        {csiRun && (
          <dl className="grid gap-x-4 gap-y-1 text-sm text-[var(--text-mid)] sm:grid-cols-2">
            <div>
              <dt className="sr-only">{t('Run mode', '运行模式')}</dt>
              <dd>{csiRun.mode === 'static' ? t('Static all links', '静态全链路') : t('Selected UE trajectory', '所选 UE 轨迹')} · {csiRun.txIds.length} AP · {csiRun.rxIds.length} UE</dd>
            </div>
            <div>
              <dt className="sr-only">{t('Samples and frequencies', '采样和频率')}</dt>
              <dd>{t(`${csiRun.timeSeconds.length} samples`, `${csiRun.timeSeconds.length} 个时刻`)} · {csiRun.carrierFrequencyGhz} GHz · {csiRun.numSubcarriers} × {csiRun.subcarrierSpacing / 1e3} kHz</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="sr-only">{t('Output and size', '输出内容及大小')}</dt>
              <dd id="csi-export-output">
                {csiRun.output === 'cir' ? t('CIR only', '仅 CIR') : t('CIR + full CFR', 'CIR + 完整 CFR')}
                {' · '}{formatCsiBytes(csiRun.uncompressedBytes)} {t('uncompressed', '未压缩')}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="sr-only">{t('CFR shape', 'CFR 张量形状')}</dt>
              <dd>
                {csiRun.output === 'cir' && t('Reconstructible CFR ', '可重建的 CFR ')}
                <span className="readout">H [{csiRun.shape.join(' × ')}]</span>{' · '}
                {t('time × UE × Rx port × AP × Tx port × subcarrier', '时间 × UE × Rx 端口 × AP × Tx 端口 × 子载波')}
              </dd>
            </div>
          </dl>
        )}
        {exportableRunId && <p className="text-xs text-[var(--text-mid)]">
          {csiRun?.output === 'cir'
            ? t('Reconstruct CFR from the path coefficients, delays, valid-path mask, and frequency grid in csi.npz. The manifest includes current AP fronthaul settings.', '可用 csi.npz 中的路径复系数、时延、有效路径掩码和频率网格重建 CFR。清单记录当前 AP 前传配置。')
            : t('The ZIP includes csi.npz from this run and manifest.json with current AP fronthaul settings.', 'ZIP 包含本次计算的 csi.npz，以及记录当前 AP 前传配置的 manifest.json。')}
        </p>}
        {currentCsiError && <p role="alert" className="text-sm text-[var(--bad)]">{currentCsiError}</p>}
        <div className="flex flex-wrap gap-2">
          <button
            id="btn-export-csi-run"
            type="button"
            onClick={handleExportCsiRun}
            disabled={!exportableRunId || !backendOnline || csiBusy}
            className="btn-signal flex cursor-pointer items-center gap-1.5 px-3 py-2 text-sm disabled:cursor-not-allowed"
          >
            {csiBusy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <FileDown size={16} aria-hidden="true" />}
            {csiBusy ? t('Preparing ZIP…', '正在打包…') : csiRun?.output === 'cir'
              ? t('Download CIR + manifest (.zip)', '下载 CIR 与清单（.zip）')
              : t('Download CSI + manifest (.zip)', '下载 CSI 与清单（.zip）')}
          </button>
          {onOpenPreview && !exportableRunId && (
            <button id="btn-return-to-preview" type="button" onClick={onOpenPreview} className={quietButton}>
              {t('Open CSI simulation', '前往 CSI 仿真')} <ArrowRight size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      </section>

      <details className="rounded-lg border border-[var(--line)] p-3">
        <summary className="cursor-pointer text-sm font-semibold">{t('Advanced exports', '高级导出')}</summary>
        <ul className="mt-2 divide-y divide-[var(--line)]">
          {additionalFiles.map(({ id, title, description, format, onClick, disabled, busy, error }) => (
            <li key={id} className="py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold">{title}</h3>
                  <p className="text-xs text-[var(--text-mid)]">{description}</p>
                </div>
                <button
                  id={id} type="button" className={quietButton}
                  aria-label={t(`Download ${title} (${format})`, `下载${title}（${format}）`)}
                  onClick={onClick} disabled={disabled}
                >
                  {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <FileDown size={15} aria-hidden="true" />}
                  {busy ? t('Preparing…', '正在准备…') : format}
                </button>
              </div>
              {error && <p role="alert" className="mt-2 break-words text-xs text-[var(--bad)]">{error}</p>}
            </li>
          ))}
          <li className="grid gap-2.5 py-2.5">
            <div>
              <h3 className="text-sm font-semibold">{t('Coverage proxy', '覆盖近似')}</h3>
              <p className="text-xs text-[var(--text-mid)]">{t(
                'Approximate scalar channel using received power and a deterministic phase for each cell.',
                '按每个栅格的接收功率和确定相位生成标量信道近似。',
              )}</p>
            </div>
            <GridFrequencyFields config={proxyGrid} onChange={setProxyGrid} />
            {!powerGrid && <p className="text-xs text-[var(--text-mid)]">
              {t('Calculate a received-power map in Coverage to download this JSON.', '请先在覆盖页计算接收功率图，再下载此 JSON。')}
            </p>}
            {proxyError && <p role="alert" className="break-words text-xs text-[var(--bad)]">{proxyError}</p>}
            <button id="btn-export-channel-grid" type="button" onClick={handleExportCoverageProxy} disabled={!powerGrid} className={`justify-self-start ${quietButton}`}>
              <FileDown size={15} aria-hidden="true" />{t('Download coverage proxy (.json)', '下载覆盖近似（.json）')}
            </button>
          </li>
          <li className="flex flex-wrap gap-2 pt-2.5">
            <button id="btn-open-cir-downloads" type="button" onClick={onOpenDiagnostics} className={quietButton}>
              {t('Compute CIR/CFR in Diagnostics', '前往诊断计算 CIR/CFR')} <ArrowRight size={15} aria-hidden="true" />
            </button>
            <button id="btn-open-grid-downloads" type="button" onClick={onOpenCoverage} className={quietButton}>
              {t('Trace grid CFR in Coverage', '前往覆盖追踪栅格 CFR')} <ArrowRight size={15} aria-hidden="true" />
            </button>
          </li>
        </ul>
      </details>
    </div>
  );
}
