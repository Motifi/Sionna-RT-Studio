/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { FileDown, Loader2 } from 'lucide-react';
import { exportChannelGrid, exportCIR, exportCIRBundle, type CIRExportOptions, type CIRFormat } from '../api';
import { useI18n } from '../i18n';
import { antennaPortCount } from '../lib/csiSize';
import type {
  BuildingFootprint, ChannelGridConfig, MaterialConfig, PropagationPath,
  RadioMapGrid, Receiver, SolverOptions, Transmitter,
} from '../types';
import { downloadFile } from './downloadFile';
import { GridFrequencyFields } from './GridFrequencyFields';

// Keep in sync with MAX_CHANNEL_GRID_CELLS in backend/solver.py.
const CHANNEL_GRID_MAX_CELLS = 16384;

interface SimulationSource {
  tx: Transmitter;
  rx: Receiver;
  txs: Transmitter[];
  rxs: Receiver[];
  buildings: BuildingFootprint[];
  paths: PropagationPath[];
  radioMap: RadioMapGrid | null;
  freqGhz: number;
  maxDepth: number;
  solverOptions: SolverOptions;
  materials: MaterialConfig[];
  csiGrid: CIRExportOptions;
  backendOnline: boolean;
}

interface SimulationDownloadsProps extends SimulationSource {
  kind: 'diagnostics' | 'coverage';
  expanded?: boolean;
}

const downloadButton = 'btn-quiet flex cursor-pointer items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs disabled:cursor-not-allowed';

function matchingArrays(devices: (Transmitter | Receiver)[]) {
  const first = devices[0]?.antennaArraySize;
  return devices.every(({ antennaArraySize: [rows, columns] }) => rows === first?.[0] && columns === first?.[1]);
}

function LinkDownloads({
  tx, rx, txs, rxs, buildings, paths, freqGhz, maxDepth, solverOptions, materials, csiGrid, backendOnline,
}: SimulationSource) {
  const { t } = useI18n();
  const [allDevices, setAllDevices] = useState(false);
  const [busy, setBusy] = useState<CIRFormat | 'bundle' | null>(null);
  const [error, setError] = useState('');
  const { numSubcarriers, subcarrierSpacing, normalizeDelays } = csiGrid;
  const hasDevices = txs.length > 0 && rxs.length > 0;
  const arraysMatch = matchingArrays(txs) && matchingArrays(rxs);
  const mixedBundle = allDevices && hasDevices && !arraysMatch;
  const canDownloadTensor = paths.length > 0 && (!allDevices || (hasDevices && arraysMatch));
  const locked = !backendOnline || busy !== null;
  const formats: { format: CIRFormat; id: string; label: string }[] = [
    { format: 'cir_npz', id: 'btn-export-raw-cir-npz', label: t('Raw CIR (.npz)', '原始 CIR（.npz）') },
    { format: 'npz', id: 'btn-export-cir-npz', label: t('CIR + CFR (.npz)', 'CIR + CFR（.npz）') },
    { format: 'cir_csv', id: 'btn-export-cir-csv', label: 'CIR (.csv)' },
    { format: 'cfr_csv', id: 'btn-export-cfr-csv', label: 'CFR (.csv)' },
  ];
  const canDownloadFormat = (format: CIRFormat) =>
    canDownloadTensor && (!allDevices || (format === 'cir_npz' || format === 'npz'));
  const pairCount = txs.length * rxs.length;

  const handleDownload = async (format: CIRFormat | 'bundle') => {
    if (locked || (format === 'bundle' ? !mixedBundle : !canDownloadFormat(format))) return;
    setBusy(format);
    setError('');
    try {
      const { blob, filename } = format === 'bundle'
        ? await exportCIRBundle(txs, rxs, buildings, freqGhz, maxDepth, solverOptions, normalizeDelays, materials)
        : await exportCIR(
          tx, rx, buildings, freqGhz, maxDepth, solverOptions, format, csiGrid, materials,
          allDevices ? { txs, rxs } : undefined,
        );
      downloadFile(blob, filename);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('CIR/CFR calculation failed.', 'CIR/CFR 计算失败。'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-2.5 pt-3 text-xs text-[var(--text-mid)]">
      <p>{t('Run PathSolver for native CIR coefficients, delays, or CFR on the scene OFDM grid.', '运行 PathSolver，计算原始 CIR 系数、时延或场景 OFDM 栅格上的 CFR。')}</p>
      <label className="flex cursor-pointer items-center gap-2 font-semibold text-[var(--text-hi)]">
        <input
          id="chk-export-all-cir-devices"
          type="checkbox"
          checked={allDevices}
          disabled={busy !== null}
          onChange={(event) => {
            setAllDevices(event.target.checked);
            setError('');
          }}
          className="accent-[var(--accent)]"
        />
        {t('All Tx × Rx links', '所有 Tx × Rx 链路')}
      </label>
      {!allDevices && <p>{t('Active link', '当前链路')} · {tx.name} → {rx.name}</p>}
      {allDevices && hasDevices && arraysMatch && (
        <p>
          <span className="readout">a [{rxs.length}, {antennaPortCount(rxs[0].antennaArraySize, solverOptions.rxPolarization)}, {txs.length}, {antennaPortCount(txs[0].antennaArraySize, solverOptions.txPolarization)}, {t('paths', '路径')}, 1]</span>
          {' · '}{t('NPZ only', '仅 NPZ')}
        </p>
      )}
      <p className="readout">{numSubcarriers} × {subcarrierSpacing / 1e3} kHz · {normalizeDelays ? t('Normalized delays', '归一化时延') : t('Absolute delays', '绝对时延')}</p>
      {mixedBundle && (
        <div className="grid gap-2 rounded border border-[var(--line)] bg-white p-2.5">
          <p>{t(
            'Mixed arrays use one raw CIR NPZ per pair. The ZIP also includes a manifest.',
            '阵列配置不同时，每条链路各生成一个原始 CIR NPZ，ZIP 同时包含清单。',
          )}</p>
          <button id="btn-export-cir-bundle" type="button" className={downloadButton} disabled={locked} onClick={() => handleDownload('bundle')}>
            {busy === 'bundle' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <FileDown size={14} aria-hidden="true" />}
            {busy === 'bundle'
              ? t(`Tracing ${pairCount} links…`, `正在追踪 ${pairCount} 条链路…`)
              : t(`All ${pairCount} links (.zip)`, `全部 ${pairCount} 条链路（.zip）`)}
          </button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        {formats.map(({ format, id, label }) => (
          <button
            id={id}
            key={format}
            type="button"
            className={downloadButton}
            disabled={locked || !canDownloadFormat(format)}
            onClick={() => handleDownload(format)}
          >
            {busy === format ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <FileDown size={14} aria-hidden="true" />}
            {busy === format ? t('Tracing…', '正在追踪…') : label}
          </button>
        ))}
      </div>
      {paths.length === 0 && !mixedBundle && (
        <p role="status">{t('Calculate an active link in Diagnostics to enable these formats.', '请先在诊断中计算当前链路，再使用这些格式。')}</p>
      )}
      {error && <p role="alert" className="break-words text-[var(--bad)]">{error}</p>}
    </div>
  );
}

function GridDownload({ tx, rx, buildings, radioMap, freqGhz, maxDepth, solverOptions, materials, backendOnline }: SimulationSource) {
  const { t } = useI18n();
  const [grid, setGrid] = useState<ChannelGridConfig>({ numSubcarriers: 64, bandwidthMhz: 100 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cellCount = radioMap?.cells.length ?? 0;
  const overCap = cellCount > CHANNEL_GRID_MAX_CELLS;
  const disabled = !backendOnline || !cellCount || overCap || busy;

  const handleDownload = async () => {
    if (disabled || !radioMap) return;
    setBusy(true);
    setError('');
    try {
      const cells = radioMap.cells.map(({ x, y, z }) => ({ x, y, z }));
      const numSubcarriers = Math.max(1, Math.round(grid.numSubcarriers));
      const subcarrierSpacing = Math.max(1, grid.bandwidthMhz * 1e6 / numSubcarriers);
      const { blob, filename } = await exportChannelGrid(
        tx, rx, buildings, cells, freqGhz, maxDepth, solverOptions,
        { numSubcarriers, subcarrierSpacing, normalizeDelays: true }, materials,
      );
      downloadFile(blob, filename);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Ray-traced CFR calculation failed.', '射线追踪 CFR 计算失败。'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-2.5 pt-3 text-xs text-[var(--text-mid)]">
      <p>{t(
        'Trace the coverage cells with the active Tx and Rx arrays and download per-port CFR.',
        '用当前 Tx 和 Rx 阵列逐格追踪，下载各端口的 CFR。',
      )}</p>
      <GridFrequencyFields config={grid} onChange={setGrid} disabled={busy} />
      {cellCount === 0 ? (
        <p role="status">{t('Calculate a coverage grid to get cell positions.', '请先计算覆盖图以获得栅格位置。')}</p>
      ) : overCap ? (
        <p role="status" className="text-[var(--warn)]">{t(
          `${cellCount.toLocaleString()} cells exceed the 16,384-cell limit. Recalculate coverage with a larger grid step.`,
          `当前有 ${cellCount.toLocaleString()} 个栅格，超过 16,384 个的上限。请增大栅格间距后重新计算覆盖。`,
        )}</p>
      ) : <p className="readout">{t(`${cellCount.toLocaleString()} cells`, `${cellCount.toLocaleString()} 个栅格`)} · {tx.name} → {rx.name}</p>}
      <button id="btn-export-raytraced-grid" type="button" className={downloadButton} disabled={disabled} onClick={handleDownload}>
        {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <FileDown size={14} aria-hidden="true" />}
        {busy ? t('Tracing cells…', '正在追踪栅格…') : t('Ray-traced CFR (.npz)', '射线追踪 CFR（.npz）')}
      </button>
      {error && <p role="alert" className="break-words text-[var(--bad)]">{error}</p>}
    </div>
  );
}

export function SimulationDownloads({ kind, expanded, ...source }: SimulationDownloadsProps) {
  const { t } = useI18n();
  const panel = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!expanded || !panel.current) return;
    panel.current.open = true;
    panel.current.querySelector('summary')?.focus({ preventScroll: true });
    panel.current.scrollIntoView({ block: 'nearest' });
  }, [expanded]);

  return (
    <details id={`simulation-downloads-${kind}`} ref={panel} className="panel p-3">
      <summary className="cursor-pointer text-sm font-semibold">{t('Compute and download', '计算并下载')}</summary>
      {kind === 'diagnostics' ? <LinkDownloads {...source} /> : <GridDownload {...source} />}
      {!source.backendOnline && (
        <p role="status" className="pt-2 text-xs text-[var(--warn)]">{t('Solver offline.', '求解器离线。')}</p>
      )}
    </details>
  );
}
