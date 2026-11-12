/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, type ReactNode } from 'react';
import { Color } from 'three';
import { Activity, Download, Navigation, Waves } from 'lucide-react';
import { useI18n } from '../i18n';
import { COLORMAP_NAMES, type ColormapName } from '../lib/colormaps';
import { coverageComparisonExport, type CoverageComparison, type CoverageSnapshot } from '../lib/coverageComparison';
import { coverageDifferenceCanvas } from '../lib/coverageDifference';
import { coverageCellValue, coverageDisplayRange, setCoverageColor } from '../lib/coverageDisplay';
import { isFloorSurface } from '../lib/sceneGeometry';
import { sceneObjectName } from '../lib/sceneLabels';
import type { BuildingFootprint, CoverageMetric, CoveragePreflight, CoverageRegion, RadioMapGrid } from '../types';
import { downloadFile } from './downloadFile';
import { NumberField } from './NumberField';

const FIELD = 'w-full min-w-0 rounded border border-[var(--line)] bg-white px-2 py-1.5 text-sm text-slate-900 focus:outline-none focus:border-[var(--accent)]';
const LABEL = 'flex min-w-0 flex-col gap-1 text-xs font-semibold text-slate-700';
const RANGE = 'w-full min-w-0 accent-[var(--accent)] cursor-ew-resize';
const BUTTON = 'rounded border border-[var(--line)] bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:border-[var(--accent)] disabled:opacity-60';
const REGION_DEFAULT = { minX: -50, maxX: 50, minY: -50, maxY: 50 };
const REGION_LIMIT = 100_000;

function useCoverageMethod() {
  const { t } = useI18n();
  return (method: RadioMapGrid['solverMethod']) => {
    if (method === 'traced_receivers') return t('Per-cell ray tracing', '逐格射线追踪');
    if (method === 'direct_receivers') return t('Per-cell direct paths', '逐格直达路径');
    return t('Planar radio-map approximation', '平面覆盖图近似');
  };
}

interface CoveragePanelProps {
  txCount: number;
  backendOnline: boolean;
  onRunHeatmap: (resolution: number, height: number, samplesPerTx: number, seed: number) => void;
  heatmapLoading: boolean;
  radioMap: RadioMapGrid | null;
  stale?: boolean;
  coverageMetric: CoverageMetric;
  setCoverageMetric: (metric: CoverageMetric) => void;
  buildings: BuildingFootprint[];
  coverageRegion: CoverageRegion | null;
  setCoverageRegion: (value: CoverageRegion | null) => void;
  coverageFloorId: string | null;
  setCoverageFloorId: (value: string | null) => void;
  coverageThreshold: number | null;
  setCoverageThreshold: (value: number | null) => void;
  preflight: CoveragePreflight | null;
  preflightLoading: boolean;
  preflightError?: string;
  jobStatus?: ReactNode;
  coverageSnapshot: CoverageSnapshot | null;
  coverageBaseline: CoverageSnapshot | null;
  setCoverageBaseline: (snapshot: CoverageSnapshot | null) => void;
  coverageComparison: CoverageComparison | null;
  coverageView: 'baseline' | 'current';
  setCoverageView: (value: 'baseline' | 'current') => void;
  coverageBandwidthMhz: number;
  coverageNoiseFigureDb: number;
  coverageHeight: number;
  setCoverageHeight: (value: number) => void;
  coverageRes: number;
  setCoverageRes: (value: number) => void;
  samplesPerTx: number;
  setSamplesPerTx: (value: number) => void;
  radioMapSeed: number;
  setRadioMapSeed: (value: number) => void;
  hasSavedRays: boolean;
  showRaysOnHeatmap: boolean;
  setShowRaysOnHeatmap: (value: boolean) => void;
  rmColormap: ColormapName;
  setRmColormap: (colormap: ColormapName) => void;
  rmAutoRange: boolean;
  setRmAutoRange: (value: boolean) => void;
  rmVmin: number;
  setRmVmin: (value: number) => void;
  rmVmax: number;
  setRmVmax: (value: number) => void;
  solveError: string;
}

export function CoveragePanel({
  txCount, backendOnline, onRunHeatmap, heatmapLoading, radioMap, stale,
  buildings, coverageRegion, setCoverageRegion, coverageFloorId, setCoverageFloorId,
  coverageThreshold, setCoverageThreshold, preflight, preflightLoading, preflightError, jobStatus,
  coverageSnapshot, coverageBaseline, setCoverageBaseline, coverageComparison, coverageView, setCoverageView,
  coverageMetric, setCoverageMetric, coverageBandwidthMhz, coverageNoiseFigureDb,
  coverageHeight, setCoverageHeight, coverageRes, setCoverageRes, samplesPerTx, setSamplesPerTx,
  radioMapSeed, setRadioMapSeed, hasSavedRays, showRaysOnHeatmap, setShowRaysOnHeatmap,
  rmColormap, setRmColormap, rmAutoRange, setRmAutoRange, rmVmin, setRmVmin, rmVmax, setRmVmax, solveError,
}: CoveragePanelProps) {
  const { t } = useI18n();
  const describeMethod = useCoverageMethod();
  const currentMap = radioMap;
  const coverageStats = currentMap?.stats;
  const resultMetric = currentMap?.metric ?? 'power';
  const isSinr = resultMetric === 'sinr';
  const floors = useMemo(() => buildings.filter(isFloorSurface), [buildings]);
  const floorMissing = coverageFloorId !== null && !floors.some(floor => floor.id === coverageFloorId);
  const invalidRegion = coverageRegion !== null &&
    (coverageRegion.minX >= coverageRegion.maxX || coverageRegion.minY >= coverageRegion.maxY);
  const defaultThreshold = coverageMetric === 'sinr' ? 0 : -90;
  const thresholdUnit = coverageMetric === 'sinr' ? 'dB' : 'dBm';
  const sharedRange = coverageComparison?.range;
  const drawable = useMemo(
    () => currentMap?.cells.some(cell => coverageCellValue(cell, resultMetric) !== null),
    [currentMap, resultMetric],
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <section id="coverage-solver-settings" className="panel flex min-w-0 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Waves size={16} className="text-[var(--accent)]" aria-hidden="true" />
            <h3 className="panel-title">{t('Coverage simulation', '覆盖仿真')}</h3>
          </div>
          {txCount > 0 && (
            <span className="text-[11px] text-slate-600">
              {txCount > 1 ? t(`Strongest AP · ${txCount} APs`, `最强 AP · ${txCount} 个 AP`) : t('1 AP', '1 个 AP')}
            </span>
          )}
        </div>

        <label className={LABEL}>
          {t('Measurement surface', '测量面')}
          <select id="select-coverage-floor" className={FIELD} value={coverageFloorId ?? ''}
            onChange={event => setCoverageFloorId(event.target.value || null)}>
            <option value="">{t('Ground / terrain', '地面／地形')}</option>
            {floorMissing && <option value={coverageFloorId ?? ''}>{t('Unavailable floor', '楼层不可用')}</option>}
            {floors.map(floor => <option key={floor.id} value={floor.id}>{sceneObjectName(floor, t) ?? floor.floor}</option>)}
          </select>
        </label>
        {floorMissing ? (
          <p role="alert" className="text-xs text-red-700">{t('Select an available floor or use ground coverage.', '请选择可用楼层或使用地面覆盖。')}</p>
        ) : floors.length === 0 && (
          <p className="text-xs text-slate-600">{t('Floor coverage requires a floor-tagged slab mesh.', '楼层覆盖需要带楼层标签的楼板网格。')}</p>
        )}
        <fieldset className="grid gap-2">
          <legend className="text-xs font-semibold text-slate-700">{t('Measurement area', '测量区域')}</legend>
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input id="check-coverage-custom-region" type="checkbox" className="accent-[var(--accent)]"
              checked={coverageRegion !== null}
              onChange={event => setCoverageRegion(event.target.checked ? REGION_DEFAULT : null)} />
            {t('Set ENU bounds (m)', '设置 ENU 边界（米）')}
          </label>
          {coverageRegion && (
            <div className="grid grid-cols-2 gap-2">
              {([
                ['minX', t('East min', '东向最小值')], ['maxX', t('East max', '东向最大值')],
                ['minY', t('North min', '北向最小值')], ['maxY', t('North max', '北向最大值')],
              ] as const).map(([key, label]) => (
                <label key={key} className={LABEL}>
                  {label}
                  <NumberField id={`coverage-region-${key}`} value={coverageRegion[key]}
                    min={-REGION_LIMIT} max={REGION_LIMIT} step="any" className={FIELD}
                    onChange={value => setCoverageRegion({ ...coverageRegion, [key]: value })} />
                </label>
              ))}
            </div>
          )}
          {invalidRegion && <p role="alert" className="text-xs text-red-700">
            {t('Each maximum must be greater than its minimum.', '两个方向的最大值都必须大于最小值。')}
          </p>}
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>
            <span className="flex flex-wrap justify-between gap-x-1">
              {coverageFloorId ? t('Height above floor', '距楼板高度') : t('Grid height', '栅格高度')}
              <span className="readout">{coverageHeight} m</span>
            </span>
            <input type="range" id="slider-coverage-height" min={0.5} max={10} step={0.5}
              className={RANGE} value={coverageHeight} onChange={event => setCoverageHeight(Number(event.target.value))} />
          </label>
          <label className={LABEL}>
            {t('Cell size (m)', '栅格间距（米）')}
            <NumberField id="slider-coverage-resolution" min={1} max={200_000} step="any" className={FIELD}
              value={coverageRes} onChange={setCoverageRes} />
          </label>
        </div>

        <label className={LABEL}>
          {t('Coverage metric', '覆盖指标')}
          <select id="select-coverage-metric" className={FIELD} value={coverageMetric}
            onChange={event => setCoverageMetric(event.target.value as CoverageMetric)}>
            <option value="power">{t('Received power (dBm)', '接收功率（dBm）')}</option>
            <option value="sinr">{t('SINR (dB)', 'SINR（dB）')}</option>
          </select>
        </label>
        {coverageMetric === 'sinr' && (
          <p className="text-[11px] text-slate-600">
            {t(
              `System bandwidth ${coverageBandwidthMhz} MHz · Noise figure ${coverageNoiseFigureDb} dB`,
              `系统带宽 ${coverageBandwidthMhz} MHz · 噪声系数 ${coverageNoiseFigureDb} dB`,
            )}
          </p>
        )}

        <div className="grid gap-2">
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input id="check-coverage-threshold" type="checkbox" className="accent-[var(--accent)]"
              checked={coverageThreshold !== null}
              onChange={event => setCoverageThreshold(event.target.checked ? defaultThreshold : null)} />
            {t('Custom served threshold', '自定义达标阈值')}
            {coverageThreshold === null && <span className="readout">{defaultThreshold} {thresholdUnit}</span>}
          </label>
          {coverageThreshold !== null && (
            <label className={LABEL}>
              {t(`Served threshold (${thresholdUnit})`, `达标阈值（${thresholdUnit}）`)}
              <NumberField id="input-coverage-threshold" step="any" className={FIELD}
                value={coverageThreshold} onChange={setCoverageThreshold} />
            </label>
          )}
        </div>

        <div className="grid grid-cols-2 items-end gap-2">
          <label className={LABEL}>
            {t('Rays per AP', '每个 AP 的射线数')}
            <select id="select-radiomap-samples" className={FIELD} value={samplesPerTx}
              onChange={event => setSamplesPerTx(Number(event.target.value))}>
              <option value={1_000}>{t('1k', '1000')}</option>
              <option value={10_000}>{t('10k', '1 万')}</option>
              <option value={100_000}>{t('100k', '10 万')}</option>
              <option value={500_000}>{t('500k', '50 万')}</option>
              <option value={1_000_000}>{t('1M · default', '100 万 · 默认')}</option>
              <option value={2_000_000}>{t('2M', '200 万')}</option>
              <option value={5_000_000}>{t('5M', '500 万')}</option>
              <option value={10_000_000}>{t('10M', '1000 万')}</option>
            </select>
          </label>
          <label className={LABEL}>
            {t('Random seed', '随机种子')}
            <NumberField id="input-radiomap-seed" integer min={0} max={2_147_483_647} step={1}
              value={radioMapSeed} onChange={setRadioMapSeed} className={FIELD} />
          </label>
        </div>

        {backendOnline && txCount > 0 && !invalidRegion && !floorMissing && (
          <CoveragePreflightReadout preflight={preflight} loading={preflightLoading} error={preflightError} />
        )}
        <button
          id="btn-compute-radio-map"
          type="button"
          onClick={() => onRunHeatmap(coverageRes, coverageHeight, samplesPerTx, radioMapSeed)}
          disabled={heatmapLoading || !backendOnline || txCount === 0 || invalidRegion || floorMissing ||
            preflightLoading || !preflight || preflight.issues.length > 0 || !!preflightError}
          className="btn-signal flex w-full items-center justify-center gap-2 px-3 py-2 text-sm cursor-pointer disabled:cursor-not-allowed"
        >
          <Activity size={15} className={heatmapLoading ? 'animate-spin' : undefined} aria-hidden="true" />
          {heatmapLoading ? t('Computing coverage…', '正在计算覆盖…') : t('Run coverage', '计算覆盖')}
        </button>
        {jobStatus}
        {!backendOnline && <p className="text-xs text-slate-600">{t('Solver is offline.', '求解器离线。')}</p>}
        {backendOnline && txCount === 0 && <p className="text-xs text-slate-600">{t('Add an AP to compute coverage.', '请添加 AP 后计算覆盖。')}</p>}
        {solveError && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{solveError}</p>}
        {stale && !heatmapLoading && (
          <p role="status" className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
            {t('Inputs changed since the last coverage map. Run coverage again to update it.', '覆盖图的输入已变化。请重新计算覆盖以更新结果。')}
          </p>
        )}
      </section>

      {currentMap && (
        <section id="coverage-result" className="panel flex min-w-0 flex-col gap-3 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="panel-title">{t('Coverage result', '覆盖结果')}</h3>
            <span className="text-[11px] text-slate-600">{isSinr ? 'SINR (dB)' : t('Received power (dBm)', '接收功率（dBm）')}</span>
          </div>
          <p className="readout text-[11px] text-slate-600">
            {describeMethod(currentMap.solverMethod)}
            {currentMap.floorElevationM != null && <> · ENU z {currentMap.floorElevationM.toFixed(2)} m + {currentMap.heightOffset} m</>}
          </p>
          {currentMap.solverMethod !== 'direct_receivers' && <p className="readout text-[11px] text-slate-600">
            {(currentMap.samplesPerTx ?? samplesPerTx).toLocaleString()}
            {currentMap.solverMethod === 'traced_receivers'
              ? t(' samples/AP per batch', ' 样本/AP/批')
              : t(' rays/AP', ' 条射线/AP')}
            {t(' · seed ', ' · 种子 ')}{currentMap.seed ?? radioMapSeed}
            {currentMap.traceBatches != null && <> · {currentMap.traceBatches} {t('receiver batches', '批接收点')}</>}
          </p>}

          {coverageStats && (
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <div className="col-span-3 flex flex-wrap items-baseline justify-between gap-x-2">
                <dt className="font-semibold text-slate-700">
                  {t('Sampled cells served', '采样栅格达标率')} (≥ {coverageStats.thresholdDb} {coverageStats.unit})
                </dt>
                <dd className="readout font-semibold text-[var(--ok)]">{coverageStats.servedPercent.toFixed(1)}%</dd>
              </div>
              {drawable && ([
                [t('P5 · edge', 'P5 · 边缘'), coverageStats.p5],
                [t('P50 · median', 'P50 · 中位'), coverageStats.p50],
                ['P95', coverageStats.p95],
              ] as const).map(([label, value]) => (
                <div key={label} className="grid gap-0.5 rounded border border-[var(--line)] bg-[var(--ink-750)] p-2">
                  <dt className="text-[11px] text-slate-600">{label}</dt>
                  <dd className="readout text-slate-900">{value.toFixed(1)} {coverageStats.unit}</dd>
                </div>
              ))}
            </dl>
          )}

          {drawable ? (
            <div className="grid gap-2 border-t border-[var(--line)] pt-3">
              <div className="grid grid-cols-2 items-end gap-2">
                <label className={LABEL}>
                  {t('Colormap', '色图')}
                  <select id="select-rm-colormap" className={FIELD} value={rmColormap}
                    onChange={event => setRmColormap(event.target.value as ColormapName)}>
                    {COLORMAP_NAMES.map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-1.5 self-end py-1.5 text-xs font-semibold text-slate-700">
                  <input type="checkbox" id="chk-rm-autorange" className="accent-[var(--accent)]"
                    checked={!sharedRange && (isSinr || rmAutoRange)} disabled={isSinr || !!sharedRange}
                    onChange={event => setRmAutoRange(event.target.checked)} />
                  {t('Auto range', '自动范围')}
                </label>
              </div>
              {sharedRange && (
                <p className="readout text-[11px] text-slate-600">
                  {t('Shared range', '共用色标')} {sharedRange.min.toFixed(1)} – {sharedRange.max.toFixed(1)} {coverageStats?.unit ?? (isSinr ? 'dB' : 'dBm')}
                </p>
              )}
              {!sharedRange && !isSinr && !rmAutoRange && (
                <div className="grid grid-cols-2 gap-2">
                  <label className={LABEL}>
                    <span className="flex flex-wrap justify-between gap-x-1">
                      {t('Lower bound', '下限')} <span className="readout">{rmVmin} dBm</span>
                    </span>
                    <input type="range" id="slider-rm-vmin" min={-200} max={0} step={1} className={RANGE}
                      value={rmVmin} onChange={event => setRmVmin(Math.min(Number(event.target.value), rmVmax))} />
                  </label>
                  <label className={LABEL}>
                    <span className="flex flex-wrap justify-between gap-x-1">
                      {t('Upper bound', '上限')} <span className="readout">{rmVmax} dBm</span>
                    </span>
                    <input type="range" id="slider-rm-vmax" min={-200} max={0} step={1} className={RANGE}
                      value={rmVmax} onChange={event => setRmVmax(Math.max(Number(event.target.value), rmVmin))} />
                  </label>
                </div>
              )}

              <button id="btn-toggle-rays-on-coverage" type="button" aria-pressed={showRaysOnHeatmap}
                disabled={!hasSavedRays && !showRaysOnHeatmap}
                onClick={() => setShowRaysOnHeatmap(!showRaysOnHeatmap)}
                className="flex items-center justify-between gap-2 rounded border border-[var(--line)] bg-[var(--ink-750)] px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:border-[var(--accent)] cursor-pointer disabled:cursor-not-allowed disabled:opacity-60">
                <span className="flex items-center gap-1.5">
                  <Navigation size={13} className="text-[var(--accent)]" aria-hidden="true" />
                  {t('Overlay saved link rays', '叠加已计算的链路射线')}
                </span>
                <span aria-hidden="true" className={`relative h-4 w-8 shrink-0 rounded-full transition-colors ${showRaysOnHeatmap ? 'bg-[var(--accent)]' : 'bg-slate-300'}`}>
                  <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${showRaysOnHeatmap ? 'left-4.5' : 'left-0.5'}`} />
                </span>
              </button>
              {!hasSavedRays && <p className="text-xs text-slate-600">
                {t('Run CSI or link diagnostics to get rays for the overlay.', '运行 CSI 或链路诊断后即可叠加射线。')}
              </p>}
            </div>
          ) : <p className="text-xs text-slate-600">{t('No cells with resolved coverage.', '没有可显示的覆盖栅格。')}</p>}
        </section>
      )}
      {(coverageSnapshot || coverageBaseline) && (
        <CoverageComparisonPanel snapshot={coverageSnapshot} baseline={coverageBaseline}
          setBaseline={setCoverageBaseline} comparison={coverageComparison} view={coverageView}
          setView={setCoverageView} colormap={rmColormap} />
      )}
    </div>
  );
}

function CoveragePreflightReadout({
  preflight, loading, error,
}: { preflight: CoveragePreflight | null; loading: boolean; error?: string }) {
  const { t } = useI18n();
  const describeMethod = useCoverageMethod();
  if (loading) return <p role="status" className="text-xs text-slate-600">{t('Checking coverage grid…', '正在检查覆盖栅格…')}</p>;
  if (error) return <p role="alert" className="text-xs text-red-700">{error}</p>;
  if (!preflight) return null;

  const format = (count: number) => count.toLocaleString();
  const rasterBytes = preflight.estimatedRasterBytes;
  const rasterSize = rasterBytes < 1024 ** 2
    ? `${(rasterBytes / 1024).toFixed(1)} KiB` : `${(rasterBytes / 1024 ** 2).toFixed(2)} MiB`;
  return (
    <section id="coverage-preflight" className="grid gap-1 rounded border border-[var(--line)] bg-[var(--ink-750)] p-2.5 text-xs text-slate-700">
      <p className="font-semibold">{describeMethod(preflight.solverMethod)}</p>
      <p className="readout">
        {format(preflight.nx)} × {format(preflight.ny)} · {format(preflight.cells)} / {format(preflight.maxCells)} {t('cells', '栅格')}
      </p>
      <p className="readout">
        {format(preflight.apCells)} / {format(preflight.maxApCells)} {t('AP–cell pairs', 'AP–栅格对')}
        {' · '}{rasterSize} {t('estimated raster', '估算栅格数据')}
      </p>
      {preflight.measuredCells !== null && preflight.measuredCells !== preflight.cells && (
        <p className="readout">{format(preflight.measuredCells)} {t('centers on the measurement surface', '个栅格中心位于测量面上')}</p>
      )}
      {preflight.traceBatches !== null && (
        <p className="readout">{format(preflight.traceBatches)} {t('receiver batches', '批接收点')}</p>
      )}
      {preflight.totalSamples !== null && preflight.totalSamples > 0 && (
        <p className="readout">
          {format(preflight.totalSamples)}
          {preflight.maxTotalSamples !== null && <> / {format(preflight.maxTotalSamples)}</>}
          {' '}{t('total samples', '总样本数')}
          {preflight.samplesPerBatch !== null && preflight.maxSamplesPerBatch !== null && (
            <> · {format(preflight.samplesPerBatch)} / {format(preflight.maxSamplesPerBatch)} {t('per batch', '每批')}</>
          )}
        </p>
      )}
      {preflight.issues.length > 0 && (
        <ul role="alert" className="grid gap-1 text-red-700">
          {preflight.issues.map(issue => <li key={issue}>{issue}</li>)}
        </ul>
      )}
    </section>
  );
}

function CoverageComparisonPanel({
  snapshot, baseline, setBaseline, comparison, view, setView, colormap,
}: {
  snapshot: CoverageSnapshot | null;
  baseline: CoverageSnapshot | null;
  setBaseline: (value: CoverageSnapshot | null) => void;
  comparison: CoverageComparison | null;
  view: 'baseline' | 'current';
  setView: (value: 'baseline' | 'current') => void;
  colormap: ColormapName;
}) {
  const { t } = useI18n();
  const hasTwoRuns = !!(snapshot && baseline && snapshot !== baseline);
  const format = (value: number | null, unit: string, signed = false) =>
    value === null ? '—' : `${signed && value > 0 ? '+' : ''}${value.toFixed(1)}${unit}`;
  return (
    <section id="coverage-comparison" className="panel flex min-w-0 flex-col gap-3 p-4">
      <h3 className="panel-title">{t('Coverage comparison', '覆盖对比')}</h3>
      <div className="flex flex-wrap gap-2">
        <button id="btn-save-coverage-baseline" type="button" className={BUTTON}
          disabled={!snapshot || snapshot === baseline} onClick={() => setBaseline(snapshot)}>
          {baseline ? t('Replace baseline with latest run', '用最新结果替换基线') : t('Save latest run as baseline', '将最新结果设为基线')}
        </button>
        {baseline && <button type="button" className={BUTTON} onClick={() => setBaseline(null)}>
          {t('Clear baseline', '清除基线')}
        </button>}
      </div>
      {baseline && !hasTwoRuns && (
        <p className="text-xs text-slate-600">
          {t('Change the deployment and run again with the same area, height, grid, and metric.', '调整部署后，使用相同的测区、高度、栅格和指标再次运行。')}
        </p>
      )}
      {hasTwoRuns && !comparison && (
        <p role="status" className="text-xs text-amber-700">
          {t('Comparison requires the same ENU origin, area, surface, grid positions, and metric.', '对比需要相同的 ENU 原点、测区、测量面、栅格坐标和指标。')}
        </p>
      )}
      {snapshot && baseline && comparison && hasTwoRuns && (
        <>
          <div className="flex flex-wrap items-center gap-2" aria-label={t('Displayed run', '显示的运行结果')}>
            <button id="btn-show-baseline-coverage" type="button" className={`${BUTTON} aria-pressed:border-[var(--accent)]`}
              aria-pressed={view === 'baseline'} onClick={() => setView('baseline')}>
              {t('A · Baseline', 'A · 基线')}
            </button>
            <button id="btn-show-current-coverage" type="button" className={`${BUTTON} aria-pressed:border-[var(--accent)]`}
              aria-pressed={view === 'current'} onClick={() => setView('current')}>
              {t('B · Latest', 'B · 最新')}
            </button>
          </div>
          <table className="w-full text-left text-xs text-slate-700">
            <thead><tr>
              <th scope="col">{t('Metric', '指标')}</th>
              <th scope="col">A</th><th scope="col">B</th><th scope="col">B − A</th>
            </tr></thead>
            <tbody className="readout">
              <tr>
                <th scope="row" className="py-1">P5</th>
                <td>{format(comparison.baseline.p5, ` ${comparison.unit}`)}</td>
                <td>{format(comparison.current.p5, ` ${comparison.unit}`)}</td>
                <td>{format(comparison.p5Db, ' dB', true)}</td>
              </tr>
              <tr>
                <th scope="row" className="py-1">{t('Served', '达标率')}</th>
                <td>{format(comparison.baseline.servedPercent, '%')}</td>
                <td>{format(comparison.current.servedPercent, '%')}</td>
                <td>{format(comparison.servedPercentPoints, t(' pp', ' 个百分点'), true)}</td>
              </tr>
            </tbody>
          </table>
          <p className="text-xs text-slate-600">
            {t('Threshold', '阈值')} {comparison.thresholdDb} {comparison.unit}
            {' · '}{comparison.matchedCells.toLocaleString()} {t('cells with finite values in both runs', '个栅格在两次运行中均有有效数值')}
          </p>
          <p className="text-xs text-slate-600">
            {t('P5 uses finite values. Served rate includes all sampled cells.', 'P5 按有效数值计算。达标率以所有采样栅格为分母。')}
          </p>
          <button id="btn-download-coverage-comparison" type="button" className={`${BUTTON} flex items-center justify-center gap-1.5`}
            onClick={() => downloadFile(JSON.stringify(coverageComparisonExport(baseline, snapshot, comparison, colormap)),
              'coverage-comparison.json', 'application/json')}>
            <Download size={14} aria-hidden="true" />{t('Download rasters and differences', '下载栅格与差值')}
          </button>
          <button id="btn-download-coverage-difference" type="button" className={`${BUTTON} flex items-center justify-center gap-1.5`}
            disabled={comparison.matchedCells === 0}
            onClick={() => coverageDifferenceCanvas(
              baseline.grid, snapshot.grid, comparison.metric,
              comparison.metric === 'sinr' ? t('SINR difference (B − A)', 'SINR 差值（B − A）')
                : t('Received power difference (B − A)', '接收功率差值（B − A）'),
              t('North ↑ · East →', '北 ↑ · 东 →'),
            )?.toBlob(blob => { if (blob) downloadFile(blob, 'coverage-difference.png'); })}>
            <Download size={14} aria-hidden="true" />{t('Download difference map (PNG)', '下载差值图（PNG）')}
          </button>
        </>
      )}
      {snapshot && (
        <button id="btn-download-coverage-raster" type="button" className={`${BUTTON} flex items-center justify-center gap-1.5`}
          onClick={() => downloadFile(JSON.stringify({
            schemaVersion: 1, coordinateFrame: 'ENU_m', provenance: snapshot.provenance, raster: snapshot.grid,
          }), 'coverage-raster.json', 'application/json')}>
          <Download size={14} aria-hidden="true" />{t('Download latest raster', '下载最新覆盖栅格')}
        </button>
      )}
    </section>
  );
}

interface CoverageLegendProps {
  radioMap: RadioMapGrid;
  colormap: ColormapName;
  autoRange: boolean;
  vmin: number;
  vmax: number;
}

export function CoverageLegend({ radioMap, colormap, autoRange, vmin, vmax }: CoverageLegendProps) {
  const { t } = useI18n();
  const range = useMemo(() => coverageDisplayRange(radioMap, autoRange, vmin, vmax), [radioMap, autoRange, vmin, vmax]);
  if (!range) return null;

  const isSinr = radioMap.metric === 'sinr';
  const unit = radioMap.unit ?? (isSinr ? 'dB' : 'dBm');
  const label = isSinr ? 'SINR' : t('Received power', '接收功率');
  const { min, max } = range;
  const color = new Color();
  const stops = Array.from({ length: 33 }, (_, index) => {
    const fraction = index / 32;
    return setCoverageColor(colormap, min + (max - min) * fraction, range, color).getStyle();
  });
  const ticks = min === max ? [min] : [min, (min + max) / 2, max];
  const formatTick = (value: number) => `${value.toFixed(1)} ${unit}`;

  return (
    <figure id="coverage-color-legend" className="grid min-w-40 gap-1 rounded-md border border-[var(--line)] bg-white px-2.5 py-2 text-[11px] text-slate-700 shadow-sm">
      <figcaption className="font-semibold">{label}</figcaption>
      <div className="h-2 rounded-sm" style={{ backgroundImage: `linear-gradient(to right, ${stops.join(', ')})` }} />
      <div className="readout flex justify-between gap-2">
        {ticks.map((value, index) => <span key={index}>{formatTick(value)}</span>)}
      </div>
    </figure>
  );
}
