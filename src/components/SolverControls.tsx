/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { Settings } from 'lucide-react';
import type { BuildingFootprint, HeightReference, Receiver, SolverOptions, SolverRoof, Transmitter } from '../types';
import { NumberField } from './NumberField';
import { useI18n } from '../i18n';
import type { StudioCsiSettings } from '../project';
import { getDeviceElevation } from '../utils';

const FREQUENCY_PRESETS_GHZ = [2.4, 5.8, 28];
const FIELD = 'w-full min-w-0 rounded border border-[var(--line)] bg-white px-2 py-1.5 text-sm text-slate-900 focus:outline-none focus:border-[var(--accent)]';
const LABEL = 'flex min-w-0 flex-col gap-1 text-xs font-semibold text-slate-700';
const RANGE = 'w-full min-w-0 accent-[var(--accent)] cursor-ew-resize';

interface SolverControlsProps {
  bandwidthMhz: number;
  onBandwidthChange: (value: number) => void;
  noiseFigureDb: number;
  onNoiseFigureChange: (value: number) => void;
  freqGhz: number;
  setFreqGhz: (value: number) => void;
  maxDepth: number;
  setMaxDepth: (value: number) => void;
  solverOptions: SolverOptions;
  setSolverOptions: (options: SolverOptions) => void;
}

export function SolverControls({
  bandwidthMhz, onBandwidthChange, noiseFigureDb, onNoiseFigureChange,
  freqGhz, setFreqGhz, maxDepth, setMaxDepth, solverOptions, setSolverOptions,
}: SolverControlsProps) {
  const { t } = useI18n();
  const [freqInput, setFreqInput] = useState(FREQUENCY_PRESETS_GHZ.includes(freqGhz) ? '' : String(freqGhz));
  const freqFocused = useRef(false);

  useEffect(() => {
    if (!freqFocused.current) setFreqInput(FREQUENCY_PRESETS_GHZ.includes(freqGhz) ? '' : String(freqGhz));
  }, [freqGhz]);

  return (
    <section id="simulation-rf-settings" className="panel flex min-w-0 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Settings size={16} className="text-[var(--accent)]" aria-hidden="true" />
        <h3 className="panel-title">{t('Shared RF settings', '共用射频设置')}</h3>
      </div>

      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-1.5 text-xs font-semibold text-slate-700">{t('Carrier frequency', '载波频率')}</legend>
        <div className="grid grid-cols-3 gap-1.5">
          {FREQUENCY_PRESETS_GHZ.map(frequency => (
            <button
              key={frequency}
              id={`btn-rf-${frequency}`}
              type="button"
              aria-pressed={freqGhz === frequency}
              onClick={() => { setFreqGhz(frequency); setFreqInput(''); }}
              className={`rounded border px-1 py-1.5 text-xs font-semibold transition cursor-pointer ${
                freqGhz === frequency
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-slate-900'
                  : 'border-[var(--line)] bg-[var(--ink-750)] text-slate-700 hover:border-[var(--accent)]'
              }`}
            >
              {frequency} GHz
            </button>
          ))}
        </div>
        <div className="flex items-end justify-between gap-2">
          <label className={LABEL}>
            {t('Custom frequency (GHz)', '自定义频率（GHz）')}
            <input
              type="number"
              id="input-rf-custom"
              min="0.1"
              max="300"
              step="0.1"
              placeholder="0.0"
              className={FIELD}
              value={freqInput}
              onFocus={() => { freqFocused.current = true; }}
              onChange={event => {
                setFreqInput(event.target.value);
                const next = Number.parseFloat(event.target.value);
                if (Number.isFinite(next) && next > 0) setFreqGhz(next);
              }}
              onBlur={() => {
                freqFocused.current = false;
                const next = Number.parseFloat(freqInput);
                if (!Number.isFinite(next) || next <= 0) {
                  setFreqInput(FREQUENCY_PRESETS_GHZ.includes(freqGhz) ? '' : String(freqGhz));
                }
              }}
            />
          </label>
          <span className="readout shrink-0 pb-1.5 text-[11px] text-slate-600">λ = {(29.9792458 / freqGhz).toFixed(2)} cm</span>
        </div>
      </fieldset>

      <div className="grid grid-cols-2 items-end gap-2">
        <label className={LABEL}>
          {t('System bandwidth (MHz)', '系统带宽（MHz）')}
          <NumberField id="input-system-bandwidth" min={1} max={400} value={bandwidthMhz}
            onChange={onBandwidthChange} className={FIELD} />
        </label>
        <label className={LABEL}>
          {t('Noise figure (dB)', '噪声系数（dB）')}
          <NumberField id="input-system-noise-figure" min={0} max={15} step={0.5} value={noiseFigureDb}
            onChange={onNoiseFigureChange} className={FIELD} />
        </label>
      </div>

      <label className={LABEL}>
        <span className="flex justify-between gap-2">
          {t('Maximum ray interaction depth', '最大射线交互深度')}
          <span className="readout">{maxDepth}</span>
        </span>
        <input type="range" id="slider-max-depth" min={0} max={8} step={1} className={RANGE} value={maxDepth}
          onChange={event => setMaxDepth(Number(event.target.value))} />
        <span className="text-[11px] font-normal text-slate-600">
          {t('Depth 0 allows direct paths only.', '深度为 0 时仅计算直达路径。')}
        </span>
      </label>

      <fieldset className="grid grid-cols-2 gap-x-2 gap-y-1.5">
        <legend className="mb-1.5 text-xs font-semibold text-slate-700">{t('Ray interactions', '射线传播机制')}</legend>
        {([
          ['los', 'Line of sight', '视距直达'],
          ['specularReflection', 'Specular reflection', '镜面反射'],
          ['diffuseReflection', 'Diffuse reflection', '漫反射'],
          ['refraction', 'Refraction', '折射'],
          ['diffraction', 'Diffraction', '绕射'],
          ...(solverOptions.diffraction ? [['edgeDiffraction', 'Edge diffraction', '边缘绕射']] as const : []),
        ] as const).map(([key, en, zh]) => (
          <label key={key} className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              id={`chk-${key}`}
              className="accent-[var(--accent)]"
              checked={solverOptions[key]}
              onChange={event => setSolverOptions({ ...solverOptions, [key]: event.target.checked })}
            />
            {t(en, zh)}
          </label>
        ))}
      </fieldset>

      <div className="grid grid-cols-2 items-end gap-2">
        <label className={LABEL}>
          {t('Path samples per source', '每个源的射线采样数')}
          <select
            id="select-path-samples"
            className={FIELD}
            value={solverOptions.pathSamplesPerSource}
            onChange={event => setSolverOptions({ ...solverOptions, pathSamplesPerSource: Number(event.target.value) })}
          >
            <option value={10_000}>{t('10k · quick check', '1 万 · 快速检查')}</option>
            <option value={100_000}>{t('100k', '10 万')}</option>
            <option value={500_000}>{t('500k', '50 万')}</option>
            <option value={1_000_000}>{t('1M · default', '100 万 · 默认')}</option>
            <option value={2_000_000}>{t('2M', '200 万')}</option>
            <option value={5_000_000}>{t('5M', '500 万')}</option>
            <option value={10_000_000}>{t('10M', '1000 万')}</option>
          </select>
        </label>
        <label className={LABEL}>
          {t('Path seed', '射线采样种子')}
          <NumberField id="input-path-seed" integer min={0} max={2_147_483_647} step={1} value={solverOptions.pathSeed}
            onChange={pathSeed => setSolverOptions({ ...solverOptions, pathSeed })} className={FIELD} />
        </label>
      </div>

      {(['tx', 'rx'] as const).map(kind => {
        const pattern = `${kind}Pattern` as const;
        const polarization = `${kind}Polarization` as const;
        return (
          <div key={kind} className="grid grid-cols-2 items-end gap-2">
            <label className={LABEL}>
              {kind === 'tx' ? t('AP antenna pattern', 'AP 天线方向图') : t('UE antenna pattern', 'UE 天线方向图')}
              <select id={`select-${kind}-pattern`} className={FIELD} value={solverOptions[pattern]}
                onChange={event => setSolverOptions({ ...solverOptions, [pattern]: event.target.value as SolverOptions[typeof pattern] })}>
                <option value="iso">{t('Isotropic', '各向同性')}</option>
                <option value="dipole">{t('Dipole', '偶极子')}</option>
                <option value="hw_dipole">{t('Half-wave dipole', '半波偶极子')}</option>
                <option value="tr38901">3GPP TR 38.901</option>
              </select>
            </label>
            <label className={LABEL}>
              {kind === 'tx' ? t('AP polarization', 'AP 极化') : t('UE polarization', 'UE 极化')}
              <select id={`select-${kind}-polarization`} className={FIELD} value={solverOptions[polarization]}
                onChange={event => setSolverOptions({ ...solverOptions, [polarization]: event.target.value as SolverOptions[typeof polarization] })}>
                <option value="V">{t('Vertical (V)', '垂直极化（V）')}</option>
                <option value="H">{t('Horizontal (H)', '水平极化（H）')}</option>
                <option value="VH">{t('Dual (VH)', '双极化（VH）')}</option>
                <option value="cross">{t('Cross (±45°)', '交叉极化（±45°）')}</option>
              </select>
            </label>
          </div>
        );
      })}
      <p className="text-[11px] text-slate-600">
        {t('Coverage uses an ideal dual-polarized isotropic receiver.', '覆盖计算使用理想的双极化各向同性接收机。')}
      </p>
    </section>
  );
}

interface DeviceRfControlsProps {
  tx: Transmitter;
  rx: Receiver;
  buildings: BuildingFootprint[];
  solverRoofs?: SolverRoof[];
  onTxUpdate: (tx: Transmitter) => void;
  onRxUpdate: (rx: Receiver) => void;
  kind: 'tx' | 'rx';
}

export function DeviceRfControls({ tx, rx, buildings, solverRoofs, onTxUpdate, onRxUpdate, kind }: DeviceRfControlsProps) {
  const { t } = useI18n();
  const isTransmitter = kind === 'tx';
  const device = isTransmitter ? tx : rx;
  const [columns, rows] = device.antennaArraySize;
  const arrayInputId = isTransmitter ? 'input-ant' : 'input-rx-ant';
  const phaseCenter = getDeviceElevation(device, buildings, solverRoofs);

  const updateDevice = (changes: Partial<Pick<Receiver, 'height' | 'heightReference' | 'antennaArraySize'>>) => {
    if (isTransmitter) onTxUpdate({ ...tx, ...changes });
    else onRxUpdate({ ...rx, ...changes });
  };

  return (
    <section key={device.id} className="panel grid min-w-0 gap-3 p-3">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <h3 className="panel-title truncate" title={device.name}>{device.name}</h3>
        <span className="shrink-0 text-[11px] font-semibold text-slate-600">{isTransmitter ? 'AP' : 'UE'}</span>
      </div>
      <div className="grid grid-cols-2 items-end gap-2">
        <label className={LABEL}>
          {t('Height reference', '高度基准')}
          <select id={`select-${kind}-height-reference`} className={FIELD} value={device.heightReference ?? 'roof'}
            onChange={event => updateDevice({ heightReference: event.target.value as HeightReference })}>
            <option value="roof">{t('Ground / roof', '地面或屋顶')}</option>
            <option value="ground">{t('Terrain', '地形')}</option>
            <option value="enu">{t('Absolute ENU', 'ENU 绝对标高')}</option>
          </select>
        </label>
        <label className={LABEL}>
          {t('Antenna height (m)', '天线高度（米）')}
          <NumberField id={`slider-${kind}-height`} value={device.height} onChange={height => updateDevice({ height })}
            step="any" min={device.heightReference === 'enu' ? undefined : 0} className={FIELD} />
        </label>
      </div>
      <p className="readout text-xs text-slate-600">
        {t('Phase center E / N / U (m)', '相位中心 东 / 北 / 高（米）')} · {device.enu.x.toFixed(3)} / {device.enu.y.toFixed(3)} / {phaseCenter?.toFixed(3) ?? '—'}
      </p>
      {phaseCenter === undefined && <p role="status" className="text-xs text-slate-700">
        {t('No terrain below this position. Move the device onto the terrain.', '此位置下方没有地形。请将设备移到地形上。')}
      </p>}

      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="mb-1 text-xs font-semibold text-slate-700">{t('Antenna array', '天线阵列')}</legend>
        <label className={LABEL}>
          {t('Columns', '列数')}
          <NumberField id={`${arrayInputId}-h`} integer min={1} max={64} value={columns}
            onChange={next => updateDevice({ antennaArraySize: [next, rows] })} className={FIELD} />
        </label>
        <label className={LABEL}>
          {t('Rows', '行数')}
          <NumberField id={`${arrayInputId}-v`} integer min={1} max={64} value={rows}
            onChange={next => updateDevice({ antennaArraySize: [columns, next] })} className={FIELD} />
        </label>
      </fieldset>

      {isTransmitter && (
        <>
          <label className={LABEL}>
            <span className="flex justify-between gap-2">{t('Transmit power', '发射功率')}<span className="readout">{tx.powerDbm} dBm</span></span>
            <input type="range" id="slider-tx-power" min={10} max={45} step={1} className={RANGE} value={tx.powerDbm}
              onChange={event => onTxUpdate({ ...tx, powerDbm: Number(event.target.value) })} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className={LABEL}>
              <span className="flex justify-between gap-2">{t('Beam azimuth', '波束方位角')}<span className="readout">{tx.beamsteeringAzimuth}°</span></span>
              <input type="range" id="slider-beam-az" min={0} max={360} step={5} className={RANGE} value={tx.beamsteeringAzimuth}
                onChange={event => onTxUpdate({ ...tx, beamsteeringAzimuth: Number(event.target.value) })} />
            </label>
            <label className={LABEL}>
              <span className="flex justify-between gap-2">{t('Beam elevation', '波束俯仰角')}<span className="readout">{tx.beamsteeringElevation}°</span></span>
              <input type="range" id="slider-beam-elevation" min={-90} max={90} step={1} className={RANGE}
                value={tx.beamsteeringElevation} aria-describedby="beam-elevation-guide"
                onChange={event => onTxUpdate({ ...tx, beamsteeringElevation: Number(event.target.value) })} />
            </label>
            <p id="beam-elevation-guide" className="col-span-2 text-[11px] text-slate-600">
              {t('Elevation is 0° at the horizon and positive upward.', '俯仰角为 0° 时指向水平，正值朝上。')}
            </p>
          </div>
        </>
      )}
    </section>
  );
}

interface CsiGridControlsProps {
  settings: StudioCsiSettings;
  onChange: (settings: StudioCsiSettings) => void;
  bandwidthMhz: number;
}

export function CsiGridControls({ settings, onChange, bandwidthMhz }: CsiGridControlsProps) {
  const { t } = useI18n();
  const gridBandwidthMhz = settings.numSubcarriers * settings.subcarrierSpacingKhz / 1000;
  const bandwidth = gridBandwidthMhz.toLocaleString(undefined, { maximumFractionDigits: 6 });

  return (
    <div className="grid grid-cols-2 items-end gap-2">
      <label className={LABEL}>
        {t('CSI subcarriers', 'CSI 子载波数')}
        <NumberField id="input-csi-subcarriers" integer min={1} max={4096} value={settings.numSubcarriers}
          onChange={numSubcarriers => onChange({ ...settings, numSubcarriers })} className={FIELD} />
      </label>
      <label className={LABEL}>
        {t('Subcarrier spacing (kHz)', '子载波间隔（kHz）')}
        <NumberField id="input-csi-spacing" min={0.001} max={1000} step="any" value={settings.subcarrierSpacingKhz}
          onChange={subcarrierSpacingKhz => onChange({ ...settings, subcarrierSpacingKhz })} className={FIELD} />
      </label>
      <p id="csi-grid-bandwidth" className="col-span-2 text-[11px] text-slate-600">
        {t('CSI grid bandwidth', 'CSI 网格带宽')} <span className="readout">{bandwidth} MHz</span>
        {gridBandwidthMhz > bandwidthMhz && (
          <span className="block text-amber-700">
            {t(`The CSI grid exceeds the ${bandwidthMhz} MHz system bandwidth.`, `CSI 网格超过 ${bandwidthMhz} MHz 的系统带宽。`)}
          </span>
        )}
      </p>
      <label className="col-span-2 flex items-center gap-1.5 text-xs text-slate-700">
        <input
          id="input-csi-normalize-delays"
          type="checkbox"
          className="accent-[var(--accent)]"
          checked={settings.normalizeDelays}
          onChange={event => onChange({ ...settings, normalizeDelays: event.target.checked })}
        />
        {t('Use each link’s first arrival as its delay reference', '以每条链路的首径作为时延参考')}
      </label>
      <p className="col-span-2 text-[11px] leading-relaxed text-slate-600">
        {t('Clear this option to retain absolute propagation delays when comparing arrivals from different APs.',
          '需要比较不同 AP 的到达时延时，取消勾选以保留绝对传播时延。')}
      </p>
    </div>
  );
}
