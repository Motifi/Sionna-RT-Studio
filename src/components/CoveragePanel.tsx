/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import { Color } from 'three';
import { Activity, Navigation, Waves } from 'lucide-react';
import { useI18n } from '../i18n';
import { COLORMAP_NAMES, type ColormapName } from '../lib/colormaps';
import { coverageCellValue, coverageDisplayRange, setCoverageColor } from '../lib/coverageDisplay';
import type { CoverageMetric, RadioMapGrid } from '../types';
import { NumberField } from './NumberField';

const FIELD = 'w-full min-w-0 rounded border border-[var(--line)] bg-white px-2 py-1.5 text-sm text-slate-900 focus:outline-none focus:border-[var(--accent)]';
const LABEL = 'flex min-w-0 flex-col gap-1 text-xs font-semibold text-slate-700';
const RANGE = 'w-full min-w-0 accent-[var(--accent)] cursor-ew-resize';

interface CoveragePanelProps {
  txCount: number;
  backendOnline: boolean;
  onRunHeatmap: (resolution: number, height: number, samplesPerTx: number, seed: number) => void;
  heatmapLoading: boolean;
  radioMap: RadioMapGrid | null;
  stale?: boolean;
  coverageMetric: CoverageMetric;
  setCoverageMetric: (metric: CoverageMetric) => void;
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
  coverageMetric, setCoverageMetric, coverageBandwidthMhz, coverageNoiseFigureDb,
  coverageHeight, setCoverageHeight, coverageRes, setCoverageRes, samplesPerTx, setSamplesPerTx,
  radioMapSeed, setRadioMapSeed, hasSavedRays, showRaysOnHeatmap, setShowRaysOnHeatmap,
  rmColormap, setRmColormap, rmAutoRange, setRmAutoRange, rmVmin, setRmVmin, rmVmax, setRmVmax, solveError,
}: CoveragePanelProps) {
  const { t } = useI18n();
  const currentMap = stale ? null : radioMap;
  const coverageStats = currentMap?.stats;
  const resultMetric = currentMap?.metric ?? 'power';
  const isSinr = resultMetric === 'sinr';
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

        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>
            <span className="flex flex-wrap justify-between gap-x-1">
              {t('Grid height', '栅格高度')} <span className="readout">{coverageHeight} m</span>
            </span>
            <input type="range" id="slider-coverage-height" min={0.5} max={10} step={0.5}
              className={RANGE} value={coverageHeight} onChange={event => setCoverageHeight(Number(event.target.value))} />
          </label>
          <label className={LABEL}>
            <span className="flex flex-wrap justify-between gap-x-1">
              {t('Cell size', '栅格间距')} <span className="readout">{coverageRes} m</span>
            </span>
            <input type="range" id="slider-coverage-resolution" min={3} max={12} step={1}
              className={RANGE} value={coverageRes} onChange={event => setCoverageRes(Number(event.target.value))} />
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

        <div className="grid grid-cols-2 items-end gap-2">
          <label className={LABEL}>
            {t('Rays per AP', '每个 AP 的射线数')}
            <select id="select-radiomap-samples" className={FIELD} value={samplesPerTx}
              onChange={event => setSamplesPerTx(Number(event.target.value))}>
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

        <button
          id="btn-compute-radio-map"
          type="button"
          onClick={() => onRunHeatmap(coverageRes, coverageHeight, samplesPerTx, radioMapSeed)}
          disabled={heatmapLoading || !backendOnline || txCount === 0}
          className="btn-signal flex w-full items-center justify-center gap-2 px-3 py-2 text-sm cursor-pointer disabled:cursor-not-allowed"
        >
          <Activity size={15} className={heatmapLoading ? 'animate-spin' : undefined} aria-hidden="true" />
          {heatmapLoading ? t('Computing coverage…', '正在计算覆盖…') : t('Run coverage', '计算覆盖')}
        </button>
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
            {(currentMap.samplesPerTx ?? samplesPerTx).toLocaleString()}{t(' rays/AP · seed ', ' 条射线/AP · 种子 ')}{currentMap.seed ?? radioMapSeed}
          </p>

          {coverageStats && (
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <div className="col-span-3 flex flex-wrap items-baseline justify-between gap-x-2">
                <dt className="font-semibold text-slate-700">
                  {t('Served', '覆盖占比')} (≥ {coverageStats.thresholdDb.toFixed(0)} {coverageStats.unit})
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
                    checked={isSinr || rmAutoRange} disabled={isSinr}
                    onChange={event => setRmAutoRange(event.target.checked)} />
                  {t('Auto range', '自动范围')}
                </label>
              </div>
              {!isSinr && !rmAutoRange && (
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
    </div>
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
