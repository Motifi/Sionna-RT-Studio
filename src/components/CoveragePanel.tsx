/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useI18n } from '../i18n';
import React from 'react';
import { RadioMapGrid, CoverageMetric } from '../types';
import { ColormapName, COLORMAP_NAMES, colormapCssGradient } from '../lib/colormaps';
import { Waves, Activity, Navigation } from 'lucide-react';
import { NumberField } from './NumberField';

interface CoveragePanelProps {
  txCount: number;
  backendOnline: boolean;
  onRunHeatmap: (resolution: number, height: number, samplesPerTx: number, seed: number) => void;
  heatmapLoading: boolean;
  radioMap: RadioMapGrid | null;
  coverageMetric: CoverageMetric;
  setCoverageMetric: (m: CoverageMetric) => void;
  coverageBandwidthMhz: number;
  setCoverageBandwidthMhz: (v: number) => void;
  coverageNoiseFigureDb: number;
  setCoverageNoiseFigureDb: (v: number) => void;
  coverageHeight: number;
  setCoverageHeight: (v: number) => void;
  coverageRes: number;
  setCoverageRes: (v: number) => void;
  samplesPerTx: number;
  setSamplesPerTx: (v: number) => void;
  radioMapSeed: number;
  setRadioMapSeed: (v: number) => void;
  showRaysOnHeatmap: boolean;
  setShowRaysOnHeatmap: (v: boolean) => void;
  rmColormap: ColormapName;
  setRmColormap: (c: ColormapName) => void;
  rmAutoRange: boolean;
  setRmAutoRange: (v: boolean) => void;
  rmVmin: number;
  setRmVmin: (v: number) => void;
  rmVmax: number;
  setRmVmax: (v: number) => void;
  solveError: string;
}

// RADIO COVERAGE VIEWPORT — Sionna RadioMapSolver controls, display, KPIs.
export function CoveragePanel({
  txCount,
  backendOnline,
  onRunHeatmap,
  heatmapLoading,
  radioMap,
  coverageMetric,
  setCoverageMetric,
  coverageBandwidthMhz,
  setCoverageBandwidthMhz,
  coverageNoiseFigureDb,
  setCoverageNoiseFigureDb,
  coverageHeight,
  setCoverageHeight,
  coverageRes,
  setCoverageRes,
  samplesPerTx,
  setSamplesPerTx,
  radioMapSeed,
  setRadioMapSeed,
  showRaysOnHeatmap,
  setShowRaysOnHeatmap,
  rmColormap,
  setRmColormap,
  rmAutoRange,
  setRmAutoRange,
  rmVmin,
  setRmVmin,
  rmVmax,
  setRmVmax,
  solveError,
}: CoveragePanelProps) {
  const { t } = useI18n();
  const coverageStats = radioMap?.stats ?? null;

  return (
    <div className="panel p-4 flex flex-col gap-4">
      <div className="flex items-center gap-1.5 justify-between">
        <div className="flex items-center gap-1.5">
          <Waves className="w-4 h-4 text-[#cc785c]" />
          <h3 className="panel-title">{t("Coverage Solver", "覆盖计算")}</h3>
        </div>
        <span className="text-[11px] px-2 py-0.5 rounded font-bold border bg-[#ebe7dc] border-[#e3e0d6] text-slate-600">
          {txCount > 1 ? t(`Best-server · ${txCount} Tx`, `最强信号 · ${txCount} 个发射端`) : t('Single Tx', '单发射端')}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3.5">
        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-slate-600 font-bold">{t("Grid Height Offset: ", "栅格高度 ")}{coverageHeight}m</label>
          <input
            type="range"
            min="0.5"
            max="10"
            step="0.5"
            className="accent-[#cc785c] cursor-ew-resize"
            value={coverageHeight}
            onChange={(e) => setCoverageHeight(parseFloat(e.target.value))}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-slate-600 font-bold">{t("Grid Step: ", "栅格间距 ")}{coverageRes}m</label>
          <input
            type="range"
            min="3"
            max="12"
            step="1"
            className="accent-[#cc785c] cursor-ew-resize"
            value={coverageRes}
            onChange={(e) => setCoverageRes(parseInt(e.target.value, 10))}
          />
        </div>
      </div>

      {/* Metric — interference-aware SINR vs. received power */}
      <div className="flex flex-col gap-1">
        <label className="text-[12px] text-slate-600 font-bold">{t("Metric", "指标")}</label>
        <select
          id="select-coverage-metric"
          className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
          value={coverageMetric}
          onChange={(e) => setCoverageMetric(e.target.value as CoverageMetric)}
        >
          <option value="power">{t("Received Power (dBm)", "接收功率（dBm）")}</option>
          <option value="sinr">{t("SINR (dB)", "SINR（dB）")}</option>
        </select>
      </div>

      {/* Noise model — only affects interference-aware SINR */}
      {coverageMetric === 'sinr' && (
        <div className="grid grid-cols-2 gap-3.5">
          <div className="flex flex-col gap-1">
            <label className="text-[12px] text-slate-600 font-bold">{t("Bandwidth: ", "带宽 ")}{coverageBandwidthMhz} MHz</label>
            <input
              type="range" min="1" max="400" step="1"
              className="accent-[#cc785c] cursor-ew-resize"
              value={coverageBandwidthMhz}
              onChange={(e) => setCoverageBandwidthMhz(parseInt(e.target.value, 10))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[12px] text-slate-600 font-bold">{t("Noise Figure: ", "噪声系数 ")}{coverageNoiseFigureDb} dB</label>
            <input
              type="range" min="0" max="15" step="0.5"
              className="accent-[#cc785c] cursor-ew-resize"
              value={coverageNoiseFigureDb}
              onChange={(e) => setCoverageNoiseFigureDb(parseFloat(e.target.value))}
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3.5 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-2.5">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-slate-600 font-bold">{t("Monte Carlo rays / Tx", "每个发射端的蒙特卡洛射线数")}</label>
          <select
            id="select-radiomap-samples"
            className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
            value={samplesPerTx}
            onChange={(event) => setSamplesPerTx(parseInt(event.target.value, 10))}
          >
            <option value={100_000}>{t("100k · preview", "10 万 · 预览")}</option>
            <option value={500_000}>{t("500k", "50 万")}</option>
            <option value={1_000_000}>{t("1M · default", "100 万 · 默认")}</option>
            <option value={2_000_000}>{t("2M · high quality", "200 万 · 高精度")}</option>
            <option value={5_000_000}>{t("5M · high quality", "500 万 · 高精度")}</option>
            <option value={10_000_000}>{t("10M · publication", "1000 万 · 高采样")}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-slate-600 font-bold">{t("Deterministic seed", "随机种子")}</label>
          <NumberField
            id="input-radiomap-seed"
            integer
            min={0}
            max={2_147_483_647}
            step={1}
            value={radioMapSeed}
            onChange={setRadioMapSeed}
            className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c]"
          />
        </div>
        <p className="col-span-2 text-[11px] text-slate-500 leading-snug">
          {t("Increase rays to reduce estimator variance. Reuse the seed for exact comparisons; change it to test convergence.", "增加射线数可降低估计方差。使用相同种子做对照，改变种子可检查收敛性。")}
        </p>
      </div>

      <button
        id="btn-compute-radio-map"
        onClick={() => onRunHeatmap(coverageRes, coverageHeight, samplesPerTx, radioMapSeed)}
        disabled={heatmapLoading || !backendOnline}
        className="w-full btn-signal text-[14px] font-bold py-2.5 px-3 rounded uppercase tracking-widest flex items-center justify-center gap-1.5 transition shadow-sm cursor-pointer border-none"
      >
        <Activity className={`w-4 h-4 text-white ${heatmapLoading ? 'animate-spin' : ''}`} />
        {heatmapLoading ? t('Computing Propagation Matrix...', "正在计算覆盖栅格…") : backendOnline ? t('Map Coverage Matrix Grid', "计算覆盖栅格") : t('Backend offline', "后端离线")}
      </button>
      {solveError && (
        <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2.5 py-1.5 font-mono">
          {solveError}
        </div>
      )}

      {/* Overlay the ray-tracing links on top of the coverage map */}
      <button
        id="btn-toggle-rays-on-coverage"
        onClick={() => setShowRaysOnHeatmap(!showRaysOnHeatmap)}
        className="flex items-center justify-between gap-2 w-full bg-[#f5f3ec] border border-[#e3e0d6] rounded px-3 py-2 cursor-pointer hover:border-[#cc785c]/50 transition"
      >
        <span className="text-[12px] font-bold text-slate-700 flex items-center gap-1.5">
          <Navigation className="w-3.5 h-3.5 text-[#cc785c]" />
          {t("Show Ray-Tracing Links", "显示传播路径")}
        </span>
        <span className={`relative w-9 h-4 rounded-full transition-colors ${showRaysOnHeatmap ? 'bg-[#cc785c]' : 'bg-slate-200'}`}>
          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${showRaysOnHeatmap ? 'left-5' : 'left-0.5'}`} />
        </span>
      </button>
      {showRaysOnHeatmap && (
        <p className="text-[11px] text-slate-600 -mt-1 leading-relaxed">
          {t("Overlays the multipath rays from the last ", "叠加上次 ")}<strong className="text-[#cc785c]">{t("Solve Link", "计算链路")}</strong> / <strong className="text-[#cc785c]">{t("Solve All Pairs", "计算所有链路")}</strong>{t(". Run a solve first if no rays appear.", "得到的多径。若没有路径，请先计算链路。")}
        </p>
      )}

      {/* Display controls — colormap + range, like sionna-rt-gui's map panel */}
      <div className="flex flex-col gap-2.5 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-bold text-slate-700">{t("Display", "显示")}</span>
          <label className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              id="chk-rm-autorange"
              className="accent-[#cc785c] cursor-pointer"
              checked={rmAutoRange}
              onChange={(e) => setRmAutoRange(e.target.checked)}
            />
            {t("Auto range", "自动范围")}
          </label>
        </div>

        <select
          id="select-rm-colormap"
          className="text-[14px] py-1.5 px-2 bg-[#ffffff] border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
          value={rmColormap}
          onChange={(e) => setRmColormap(e.target.value as ColormapName)}
        >
          {COLORMAP_NAMES.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>

        {!rmAutoRange && (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-slate-600 font-bold">{t("vmin: ", "下限 ")}{rmVmin} dBm</span>
              <input
                type="range"
                id="slider-rm-vmin"
                min="-200"
                max="0"
                step="1"
                className="accent-[#cc785c] cursor-ew-resize"
                value={rmVmin}
                onChange={(e) => setRmVmin(Math.min(parseInt(e.target.value, 10), rmVmax))}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-slate-600 font-bold">{t("vmax: ", "上限 ")}{rmVmax} dBm</span>
              <input
                type="range"
                id="slider-rm-vmax"
                min="-200"
                max="0"
                step="1"
                className="accent-[#cc785c] cursor-ew-resize"
                value={rmVmax}
                onChange={(e) => setRmVmax(Math.max(parseInt(e.target.value, 10), rmVmin))}
              />
            </div>
          </div>
        )}

        {/* Colorbar legend, scaled to the effective range (metric-aware) */}
        {radioMap && (() => {
          const unit = radioMap.unit ?? 'dBm';
          const isSinr = (radioMap.metric ?? 'power') === 'sinr';
          const useManual = !rmAutoRange && !isSinr;
          let vmin = rmVmin;
          let vmax = rmVmax;
          if (!useManual) {
            if (radioMap.stats) {
              vmin = radioMap.stats.minVal;
              vmax = radioMap.stats.maxVal;
            } else {
              const powers = radioMap.cells.map((c) => c.powerDbm).filter((p) => Number.isFinite(p) && p > -300);
              vmin = powers.length ? Math.min(...powers) : -120;
              vmax = powers.length ? Math.max(...powers) : -50;
            }
          }
          const vmid = (vmin + vmax) / 2;
          const label = isSinr ? 'SINR' : t('Received Power', "接收功率");
          return (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-slate-600 uppercase tracking-widest">{label} · {rmColormap}</span>
              <div className="w-full h-3 rounded" style={{ backgroundImage: colormapCssGradient(rmColormap) }} />
              <div className="flex justify-between font-mono text-[11px] text-slate-600">
                <span>{vmin.toFixed(0)} {unit}</span>
                <span>{vmid.toFixed(0)} {unit}</span>
                <span>{vmax.toFixed(0)} {unit}</span>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Coverage statistics (served %, percentiles) from the Sionna radio map */}
      {coverageStats && (
        <div className="flex flex-col gap-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-bold text-slate-700">{t("Coverage KPIs", "覆盖指标")}</span>
            <span className="text-[11px] px-2 py-0.5 rounded font-bold border bg-white border-[#e3e0d6] text-slate-600">
              {coverageStats.metric === 'sinr' ? 'SINR' : t('Power', "功率")}
            </span>
          </div>
          <span className="text-[11px] text-slate-500 font-mono">
            {(radioMap?.samplesPerTx ?? samplesPerTx).toLocaleString()}{t(" rays/Tx · seed ", " 条射线/发射端 · 种子 ")}{radioMap?.seed ?? radioMapSeed}
          </span>
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-slate-600 font-semibold">
              {t("Served (≥ ", "覆盖占比（≥ ")}{coverageStats.thresholdDb.toFixed(0)} {coverageStats.unit})
            </span>
            <span className="font-mono text-[14px] font-bold text-[#5f7f5a]">{coverageStats.servedPercent.toFixed(1)}%</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            {([[t('Cell-edge (p5)', "边缘（第 5 百分位）"), coverageStats.p5], [t('Median (p50)', "中位数（第 50 百分位）"), coverageStats.p50], [t('Peak (p95)', "高分位（第 95 百分位）"), coverageStats.p95]] as const).map(([lab, val]) => (
              <div key={lab} className="flex flex-col gap-0.5 bg-white border border-[#e3e0d6] rounded py-1.5">
                <span className="text-[11px] text-slate-500 font-bold">{lab}</span>
                <span className="font-mono text-[13px] font-bold text-slate-800">{val.toFixed(1)}</span>
                <span className="text-[11px] text-slate-400">{coverageStats.unit}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
