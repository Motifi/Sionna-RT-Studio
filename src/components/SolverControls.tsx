/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Transmitter, Receiver, SolverOptions } from '../types';
import { Settings } from 'lucide-react';
import { NumberField } from './NumberField';
import { useI18n } from '../i18n';
import type { StudioCsiSettings } from '../project';

interface SolverControlsProps {
  tx: Transmitter;
  rx: Receiver;
  onTxUpdate: (tx: Transmitter) => void;
  onRxUpdate: (rx: Receiver) => void;
  section: 'scene' | 'planning';
  bandwidthMhz?: number;
  onBandwidthChange?: (value: number) => void;
  noiseFigureDb?: number;
  onNoiseFigureChange?: (value: number) => void;
  csiSettings?: StudioCsiSettings;
  onCsiSettingsChange?: (settings: StudioCsiSettings) => void;
  freqGhz: number;
  setFreqGhz: (val: number) => void;
  maxDepth: number;
  setMaxDepth: (val: number) => void;
  solverOptions: SolverOptions;
  setSolverOptions: (opts: SolverOptions) => void;
}

// Scene-wide propagation settings and the selected devices' RF parameters.
export function SolverControls({
  tx,
  rx,
  onTxUpdate,
  onRxUpdate,
  section,
  bandwidthMhz,
  onBandwidthChange,
  noiseFigureDb,
  onNoiseFigureChange,
  csiSettings,
  onCsiSettingsChange,
  freqGhz,
  setFreqGhz,
  maxDepth,
  setMaxDepth,
  solverOptions,
  setSolverOptions,
}: SolverControlsProps) {
  const { t } = useI18n();
  const {
    powerDbm: txPower,
    height: txHeight,
    beamsteeringAzimuth: beamsteeringAz,
    beamsteeringElevation: beamsteeringEl,
  } = tx;
  const { height: rxHeight } = rx;
  const [txAntH, txAntV] = tx.antennaArraySize;
  const [rxAntH, rxAntV] = rx.antennaArraySize;
  const setTxPower = (powerDbm: number) => onTxUpdate({ ...tx, powerDbm });
  const setTxHeight = (height: number) => onTxUpdate({ ...tx, height });
  const setRxHeight = (height: number) => onRxUpdate({ ...rx, height });
  const setBeamsteeringAz = (beamsteeringAzimuth: number) => onTxUpdate({ ...tx, beamsteeringAzimuth });
  const setTxAntH = (cols: number) => onTxUpdate({ ...tx, antennaArraySize: [cols, txAntV] });
  const setTxAntV = (rows: number) => onTxUpdate({ ...tx, antennaArraySize: [txAntH, rows] });
  const setRxAntH = (cols: number) => onRxUpdate({ ...rx, antennaArraySize: [cols, rxAntV] });
  const setRxAntV = (rows: number) => onRxUpdate({ ...rx, antennaArraySize: [rxAntH, rows] });

  // Custom carrier-frequency field keeps its own text so the user can clear it
  // or type intermediate values ("2", "2.") without the controlled number value
  // snapping back. The box stays empty (placeholder) while a preset is active,
  // so it reads as "type a custom value" rather than a fourth fixed preset.
  const FREQ_PRESETS = [2.4, 5.8, 28.0];
  const [freqInput, setFreqInput] = useState(FREQ_PRESETS.includes(freqGhz) ? '' : String(freqGhz));
  const freqFocused = useRef(false);
  useEffect(() => {
    // Reconcile when freqGhz changes elsewhere (e.g. preset buttons), but don't
    // disturb an active edit. A preset value clears the box back to placeholder.
    if (freqFocused.current) return;
    if (FREQ_PRESETS.includes(freqGhz)) setFreqInput('');
    else if (parseFloat(freqInput) !== freqGhz) setFreqInput(String(freqGhz));
  }, [freqGhz]);

  const gridBandwidthMhz = csiSettings
    ? csiSettings.numSubcarriers * csiSettings.subcarrierSpacingKhz / 1000
    : 0;
  const systemInput = 'w-full rounded border border-[var(--line)] bg-white px-2 py-1.5 text-[14px] text-slate-900 focus:outline-none focus:border-[var(--accent)]';

  return (
    <div className="flex flex-col gap-4">
      {/* CORE RF PARAMETERS MODULATOR */}
      <div className="panel p-4 flex flex-col gap-4">
        <div className="flex items-center gap-1.5">
          <Settings className="w-4 h-4 text-[#cc785c]" />
          <h3 className="panel-title">{section === 'scene'
              ? t('Wireless system', '无线系统参数')
              : t('Selected device RF settings', '所选设备射频参数')}</h3>
        </div>

        {section === 'scene' ? (
          <>
            {/* Carrier frequency: presets + custom input box */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-bold text-[#6b6862]">{t('Carrier Frequency Channel', '载波频率')}</label>
              <div className="grid grid-cols-4 gap-1.5">
                {FREQ_PRESETS.map((fq) => (
                  <button
                    key={fq}
                    id={`btn-rf-${fq}`}
                    onClick={() => { setFreqGhz(fq); setFreqInput(''); }}
                    className={`py-1.5 px-0.5 rounded border text-[14px] font-bold transition-all cursor-pointer ${
                      freqGhz === fq
                        ? 'bg-[#cc785c] text-white border-none shadow-md shadow-[#cc785c]/20'
                        : 'bg-[#f5f3ec] text-[#6b6862] border-[#e3e0d6] hover:bg-[#ebe7dc] hover:text-slate-900'
                    }`}
                  >
                    {fq === 28 ? t('28 GHz mmW', '28 GHz') : `${fq} GHz`}
                  </button>
                ))}
                {/* Custom frequency input (GHz) — empty placeholder until typed */}
                <div className={`flex items-center rounded border overflow-hidden ${
                  !FREQ_PRESETS.includes(freqGhz)
                    ? 'border-[#cc785c] bg-[#ebe7dc]'
                    : 'border-dashed border-[#d6d2c4] bg-white'
                }`}>
                  <input
                    type="number"
                    id="input-rf-custom"
                    min="0.1"
                    max="300"
                    step="0.1"
                    placeholder="0.0"
                    title={t('Custom carrier frequency in GHz', '自定义载波频率（GHz）')}
                    className="w-full text-[14px] py-1.5 px-1.5 bg-transparent text-center focus:outline-none text-slate-900 font-bold placeholder:font-normal placeholder:text-slate-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    value={freqInput}
                    onFocus={() => { freqFocused.current = true; }}
                    onChange={(e) => {
                      setFreqInput(e.target.value);
                      const v = parseFloat(e.target.value);
                      if (!Number.isNaN(v) && v > 0) setFreqGhz(v);
                    }}
                    onBlur={() => {
                      freqFocused.current = false;
                      // Leave the box empty (placeholder) if cleared while a preset is
                      // active; otherwise restore the active custom number.
                      const v = parseFloat(freqInput);
                      if (Number.isNaN(v) || v <= 0) {
                        setFreqInput(FREQ_PRESETS.includes(freqGhz) ? '' : String(freqGhz));
                      }
                    }}
                  />
                  <span className="text-[11px] text-slate-600 font-bold pr-1.5">GHz</span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-slate-600 font-bold">{t('Carrier', '载波')}: {freqGhz} GHz</span>
                <span className="text-[11px] text-[#5f7f5a] font-mono">
                  λ = {((0.3 / (freqGhz + 1e-9)) * 100).toFixed(2)} cm
                </span>
            </div>

            {bandwidthMhz !== undefined && noiseFigureDb !== undefined && csiSettings
              && onBandwidthChange && onNoiseFigureChange && onCsiSettingsChange && (
              <div className="grid grid-cols-2 gap-2 rounded border border-[var(--line)] bg-[var(--ink-750)] p-2.5">
                <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-slate-700">
                  {t('System bandwidth (MHz)', '系统带宽（MHz）')}
                  <NumberField id="input-system-bandwidth" min={1} max={400} value={bandwidthMhz}
                    onChange={onBandwidthChange} className={systemInput} />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-slate-700">
                  {t('Noise figure (dB)', '噪声系数（dB）')}
                  <NumberField id="input-system-noise-figure" min={0} max={15} step={0.5} value={noiseFigureDb}
                    onChange={onNoiseFigureChange} className={systemInput} />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-slate-700">
                  {t('CSI subcarriers', 'CSI 子载波数')}
                  <NumberField id="input-csi-subcarriers" integer min={1} max={4096}
                    value={csiSettings.numSubcarriers}
                    onChange={(numSubcarriers) => onCsiSettingsChange({ ...csiSettings, numSubcarriers })}
                    className={systemInput} />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-slate-700">
                  {t('Subcarrier spacing (kHz)', '子载波间隔（kHz）')}
                  <NumberField id="input-csi-spacing" min={0.001} max={1000} step="any"
                    value={csiSettings.subcarrierSpacingKhz}
                    onChange={(subcarrierSpacingKhz) => onCsiSettingsChange({ ...csiSettings, subcarrierSpacingKhz })}
                    className={systemInput} />
                </label>
                <p id="csi-grid-bandwidth" className="col-span-2 text-[11px] text-slate-600">
                  {t('CSI grid bandwidth', 'CSI 网格带宽')} {gridBandwidthMhz.toLocaleString(undefined, { maximumFractionDigits: 6 })} MHz
                  {' · '}{t('subcarriers × spacing', '子载波数 × 间隔')}
                  {gridBandwidthMhz > bandwidthMhz && (
                    <span className="block text-amber-800">
                      {t('The CSI grid exceeds the system bandwidth.', 'CSI 网格带宽超过系统带宽。')}
                    </span>
                  )}
                </p>
                <label className="col-span-2 flex items-center gap-1.5 text-[12px] font-semibold text-slate-700">
                  <input
                    id="input-csi-normalize-delays"
                    type="checkbox"
                    checked={csiSettings.normalizeDelays}
                    onChange={(event) => onCsiSettingsChange({ ...csiSettings, normalizeDelays: event.target.checked })}
                  />
                  {t('Use the first arrival of each link as the delay reference', '以每条链路的首径作为时延参考')}
                </label>
              </div>
            )}

            {/* Sionna RT max interaction depth (reflections / diffractions per ray) */}
            <div className="flex flex-col gap-1">
              <label className="text-[12px] text-slate-600 font-bold">
                {t('Max Depth (Ray Bounces)', '最大射线交互深度')}: {maxDepth}
              </label>
              <input
                type="range"
                id="slider-max-depth"
                min="0"
                max="8"
                step="1"
                className="accent-[#cc785c] cursor-ew-resize"
                value={maxDepth}
                onChange={(e) => setMaxDepth(parseInt(e.target.value, 10))}
              />
              <span className="text-[12px] text-slate-700 font-mono font-medium">
                {t('0 = LOS only · higher = more reflections (slower)', '0 表示仅计算视距路径。增加深度可纳入更多次反射，但耗时更长。')}
              </span>
            </div>

            {/* Ray interaction types (sionna-rt-gui feature checkboxes) — applied
                to link solves, mobility AND radio maps. */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-bold text-[#6b6862]">{t('Ray Interactions', '射线传播机制')}</label>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                {([
                  ['los', 'Line of sight', '视距直达'],
                  ['specularReflection', 'Specular reflection', '镜面反射'],
                  ['diffuseReflection', 'Diffuse reflection', '漫反射'],
                  ['refraction', 'Refraction', '折射'],
                  ['diffraction', 'Diffraction', '绕射'],
                ] as const).map(([key, en, zh]) => (
                  <label key={key} className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      id={`chk-${key}`}
                      className="accent-[#cc785c] cursor-pointer"
                      checked={solverOptions[key]}
                      onChange={(e) => setSolverOptions({ ...solverOptions, [key]: e.target.checked })}
                    />
                    {t(en, zh)}
                  </label>
                ))}
                {solverOptions.diffraction && (
                  <label className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      id="chk-edgeDiffraction"
                      className="accent-[#cc785c] cursor-pointer"
                      checked={solverOptions.edgeDiffraction}
                      onChange={(e) => setSolverOptions({ ...solverOptions, edgeDiffraction: e.target.checked })}
                    />
                    {t('Edge diffraction', '边缘绕射')}
                  </label>
                )}
              </div>
            </div>

            {/* PathSolver sampling controls. Specular candidates use shooting and
                bouncing, so sample count and seed belong in reproducible studies. */}
            <div className="grid grid-cols-2 gap-3 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-2.5">
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-slate-600 font-bold">{t('Path samples / source', '每源射线采样数')}</span>
                <select
                  id="select-path-samples"
                  className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
                  value={solverOptions.pathSamplesPerSource}
                  onChange={(event) => setSolverOptions({
                    ...solverOptions,
                    pathSamplesPerSource: parseInt(event.target.value, 10),
                  })}
                >
                  <option value={10_000}>{t('10k · quick check', '1 万 · 快速检查')}</option>
                  <option value={100_000}>{t('100k · preview', '10 万 · 预览')}</option>
                  <option value={500_000}>500k</option>
                  <option value={1_000_000}>{t('1M · default', '100 万 · 默认')}</option>
                  <option value={2_000_000}>2M</option>
                  <option value={5_000_000}>{t('5M · high quality', '500 万 · 高精度')}</option>
                  <option value={10_000_000}>{t('10M · publication', '1000 万 · 论文实验')}</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-slate-600 font-bold">{t('Path seed', '射线采样随机种子')}</span>
                <NumberField
                  id="input-path-seed"
                  integer
                  min={0}
                  max={2_147_483_647}
                  step={1}
                  value={solverOptions.pathSeed}
                  onChange={(pathSeed) => setSolverOptions({ ...solverOptions, pathSeed })}
                  className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c]"
                />
              </div>
              <p className="col-span-2 text-[11px] text-slate-500 leading-snug">
                {t('Applies to Link, Trajectory, CIR/CFR, and ray-traced dataset solves. Pin both values when comparing results.', '适用于链路分析、移动轨迹、CIR/CFR 和射线追踪数据集。对比结果时请固定采样数和随机种子。')}
              </p>
            </div>

            {/* Scene-level Tx/Rx antenna patterns and polarizations, matching
                Sionna RT's scene.tx_array / scene.rx_array model. */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-slate-600 font-bold">{t('TX Antenna Pattern', '发射天线方向图')}</span>
                <select
                  id="select-tx-pattern"
                  className="text-[14px] py-1.5 px-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
                  value={solverOptions.txPattern}
                  onChange={(e) => setSolverOptions({ ...solverOptions, txPattern: e.target.value as SolverOptions['txPattern'] })}
                >
                  <option value="iso">{t('Isotropic', '各向同性')}</option>
                  <option value="dipole">{t('Dipole', '偶极子')}</option>
                  <option value="hw_dipole">{t('Half-wave dipole', '半波偶极子')}</option>
                  <option value="tr38901">3GPP TR 38.901</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-slate-600 font-bold">{t('TX Polarization', '发射极化')}</span>
                <select
                  id="select-tx-polarization"
                  className="text-[14px] py-1.5 px-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
                  value={solverOptions.txPolarization}
                  onChange={(e) => setSolverOptions({ ...solverOptions, txPolarization: e.target.value as SolverOptions['txPolarization'] })}
                >
                  <option value="V">{t('Vertical (V)', '垂直极化（V）')}</option>
                  <option value="H">{t('Horizontal (H)', '水平极化（H）')}</option>
                  <option value="VH">{t('Dual (VH)', '双极化（VH）')}</option>
                  <option value="cross">{t('Cross (±45°)', '交叉极化（±45°）')}</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-slate-600 font-bold">{t('RX Antenna Pattern', '接收天线方向图')}</span>
                <select
                  id="select-rx-pattern"
                  className="text-[14px] py-1.5 px-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
                  value={solverOptions.rxPattern}
                  onChange={(e) => setSolverOptions({ ...solverOptions, rxPattern: e.target.value as SolverOptions['rxPattern'] })}
                >
                  <option value="iso">{t('Isotropic', '各向同性')}</option>
                  <option value="dipole">{t('Dipole', '偶极子')}</option>
                  <option value="hw_dipole">{t('Half-wave dipole', '半波偶极子')}</option>
                  <option value="tr38901">3GPP TR 38.901</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-slate-600 font-bold">{t('RX Polarization', '接收极化')}</span>
                <select
                  id="select-rx-polarization"
                  className="text-[14px] py-1.5 px-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
                  value={solverOptions.rxPolarization}
                  onChange={(e) => setSolverOptions({ ...solverOptions, rxPolarization: e.target.value as SolverOptions['rxPolarization'] })}
                >
                  <option value="V">{t('Vertical (V)', '垂直极化（V）')}</option>
                  <option value="H">{t('Horizontal (H)', '水平极化（H）')}</option>
                  <option value="VH">{t('Dual (VH)', '双极化（VH）')}</option>
                  <option value="cross">{t('Cross (±45°)', '交叉极化（±45°）')}</option>
                </select>
              </div>
              <p className="col-span-2 text-[11px] text-slate-500 leading-snug">
                {t("RX settings configure the physical scene.rx_array for Link, Trajectory, CIR/CFR, and ray-traced datasets. Coverage uses Sionna RadioMapSolver's ideal dual-polarized isotropic receiver.", '接收设置定义链路分析、移动轨迹、CIR/CFR 和射线追踪数据集使用的接收阵列 scene.rx_array。无线覆盖使用 Sionna RadioMapSolver 的理想双极化各向同性接收机。')}
              </p>
            </div>

          </>
        ) : (
          <>
            {/* Sliders for Tx Power, Heights, Antenna Beam steering */}
            <p className="text-[12px] text-slate-600">
              {t('Transmitter', '发射端')} <strong className="text-slate-800">{tx.name}</strong>
              {' · '}{t('Receiver', '接收端')} <strong className="text-slate-800">{rx.name}</strong>
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-slate-600 font-bold">{t('TX Power', '发射功率')}: {txPower} dBm</span>
                <input
                  type="range"
                  id="slider-tx-power"
                  min="10"
                  max="45"
                  step="1"
                  className="accent-[#cc785c] cursor-ew-resize"
                  value={txPower}
                  onChange={(e) => setTxPower(parseInt(e.target.value, 10))}
                />
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-slate-600 font-bold">{t('TX Array', '发射阵列')}: {txAntH} × {txAntV}</span>
                <div className="flex gap-1.5">
                  <NumberField
                    id="input-ant-h"
                    integer
                    min={1}
                    max={64}
                    value={txAntH}
                    onChange={setTxAntH}
                    className="w-1/2 text-[14px] py-1 px-2 border border-[#e3e0d6] bg-[#f5f3ec] rounded text-center focus:outline-none focus:border-[#cc785c] text-slate-900"
                  />
                  <span className="text-slate-600 self-center">×</span>
                  <NumberField
                    id="input-ant-v"
                    integer
                    min={1}
                    max={64}
                    value={txAntV}
                    onChange={setTxAntV}
                    className="w-1/2 text-[14px] py-1 px-2 border border-[#e3e0d6] bg-[#f5f3ec] rounded text-center focus:outline-none focus:border-[#cc785c] text-slate-900"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-slate-600 font-bold">{t('RX Array', '接收阵列')}: {rxAntH} × {rxAntV}</span>
                <div className="flex gap-1.5">
                  <NumberField
                    id="input-rx-ant-h"
                    integer
                    min={1}
                    max={64}
                    value={rxAntH}
                    onChange={setRxAntH}
                    className="w-1/2 text-[14px] py-1 px-2 border border-[#e3e0d6] bg-[#f5f3ec] rounded text-center focus:outline-none focus:border-[#cc785c] text-slate-900"
                  />
                  <span className="text-slate-600 self-center">×</span>
                  <NumberField
                    id="input-rx-ant-v"
                    integer
                    min={1}
                    max={64}
                    value={rxAntV}
                    onChange={setRxAntV}
                    className="w-1/2 text-[14px] py-1 px-2 border border-[#e3e0d6] bg-[#f5f3ec] rounded text-center focus:outline-none focus:border-[#cc785c] text-slate-900"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-slate-600 font-bold">{t('Beam Azimuth', '波束方位角')}: {beamsteeringAz}°</span>
                <input
                  type="range"
                  id="slider-beam-az"
                  min="0"
                  max="360"
                  step="5"
                  className="accent-[#cc785c] cursor-ew-resize"
                  value={beamsteeringAz}
                  onChange={(e) => setBeamsteeringAz(parseInt(e.target.value, 10))}
                />
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="slider-beam-elevation" className="text-[12px] text-slate-600 font-bold">
                  {t('Beam Elevation', '波束俯仰角')} {beamsteeringEl}°
                </label>
                <input
                  type="range"
                  id="slider-beam-elevation"
                  min="-90"
                  max="90"
                  step="1"
                  className="accent-[#cc785c] cursor-ew-resize"
                  value={beamsteeringEl}
                  aria-describedby="beam-elevation-guide"
                  onChange={(event) => onTxUpdate({ ...tx, beamsteeringElevation: Number(event.target.value) })}
                />
                <span id="beam-elevation-guide" className="text-[11px] text-slate-600">
                  {t('0° horizontal · negative down · positive up', '0° 水平，负值朝下，正值朝上')}
                </span>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-slate-600 font-bold">{t('TX Tower Height', '发射天线高度')}: {txHeight} m</span>
                <input
                  type="range"
                  id="slider-tx-height"
                  min="1"
                  max="40"
                  step="0.5"
                  className="accent-[#cc785c] cursor-ew-resize"
                  value={txHeight}
                  onChange={(e) => setTxHeight(parseFloat(e.target.value))}
                />
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-slate-600 font-bold">{t('RX Device Height', '接收设备高度')}: {rxHeight} m</span>
                <input
                  type="range"
                  id="slider-rx-height"
                  min="1"
                  max="10"
                  step="0.5"
                  className="accent-[#cc785c] cursor-ew-resize"
                  value={rxHeight}
                  onChange={(e) => setRxHeight(parseFloat(e.target.value))}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
