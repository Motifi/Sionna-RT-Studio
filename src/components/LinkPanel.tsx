/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useI18n } from '../i18n';
import React from 'react';
import { Transmitter, Receiver, PropagationPath, ChannelMetrics, MatrixCell } from '../types';
import { Waves, Activity, Zap } from 'lucide-react';

interface LinkPanelProps {
  txs: Transmitter[];
  rxs: Receiver[];
  activeTxId: string;
  activeRxId: string;
  matrix: Record<string, MatrixCell>;
  matrixLoading: boolean;
  matrixProgress: string;
  onSolveMatrix: () => void;
  onSelectPair: (txId: string, rxId: string) => void;
  paths: PropagationPath[];
  metrics: ChannelMetrics;
  hasResult: boolean;
  onSolve: () => void;
  solving: boolean;
  solveError: string;
  backendOnline: boolean;
}

// Channel Impulse Response Taps Chart
function CIRChart({ paths }: { paths: PropagationPath[] }) {
  const { t } = useI18n();
  const minDelay = 0;
  const maxDelay = Math.max(...paths.map((p) => p.delayNs)) * 1.15 || 500;
  const minPower = -120;
  const maxPower = -30;

  const mapX = (ns: number) => 40 + ((ns - minDelay) / (maxDelay - minDelay)) * 340;
  const mapY = (dbm: number) => 10 + (1 - (dbm - minPower) / (maxPower - minPower)) * 90;

  return (
    <div className="bg-[#f5f3ec] border border-[#e3e0d6] rounded p-3 flex flex-col gap-2">
      <h4 className="panel-title flex items-center gap-1.5">
        <Activity className="w-3.5 h-3.5 text-[#cc785c]" />
        {t("Multipath Channel Impulse Response (CIR Taps)", "多径信道冲激响应（CIR 抽头）")}
      </h4>

      <svg className="w-full h-[140px]" viewBox="-28 -4 436 136">
        {/* Grid lines */}
        <line x1="40" y1="100" x2="380" y2="100" stroke="#cbc6b6" strokeWidth="1" />
        <line x1="40" y1="10" x2="40" y2="100" stroke="#cbc6b6" strokeWidth="1" />

        {/* Label coordinates */}
        <text x="35" y="10" textAnchor="end" fontSize="12" fontWeight="700" fill="#141413" fontFamily="monospace">
          -30 dBm
        </text>
        <text x="35" y="55" textAnchor="end" fontSize="12" fontWeight="700" fill="#141413" fontFamily="monospace">
          -75 dBm
        </text>
        <text x="35" y="100" textAnchor="end" fontSize="12" fontWeight="700" fill="#141413" fontFamily="monospace">
          -120 dBm
        </text>

        <text x="40" y="112" fontSize="12" fontWeight="700" fill="#141413" fontFamily="monospace">
          0ns
        </text>
        <text x="210" y="112" textAnchor="middle" fontSize="12" fontWeight="700" fill="#141413" fontFamily="monospace">
          {(maxDelay / 2).toFixed(0)}ns
        </text>
        <text x="380" y="112" textAnchor="end" fontSize="12" fontWeight="700" fill="#141413" fontFamily="monospace">
          {maxDelay.toFixed(0)}{t("ns (Delay)", "ns（时延）")}
        </text>

        {/* Wave vertical taps */}
        {paths.map((path) => {
          const txVal = mapX(path.delayNs);
          const tyVal = mapY(Math.min(-30, Math.max(-120, path.receivedPowerDbm)));
          const isLOS = path.type === 'LOS';

          return (
            <g key={path.id}>
              {/* Discrete trace bar */}
              <line
                x1={txVal}
                y1="100"
                x2={txVal}
                y2={tyVal}
                stroke={isLOS ? '#5f7f5a' : '#cc785c'}
                strokeWidth={isLOS ? '3' : '1.5'}
                strokeDasharray={isLOS ? '0' : '1'}
              />
              {/* Tap point */}
              <circle
                cx={txVal}
                cy={tyVal}
                r={isLOS ? '4' : '2.5'}
                fill={isLOS ? '#5f7f5a' : '#cc785c'}
                className="hover:scale-150 transition-all duration-150 cursor-pointer"
              >
                <title>{`${path.type}: ${path.receivedPowerDbm.toFixed(1)} dBm @ ${path.delayNs.toFixed(1)}ns`}</title>
              </circle>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Link analysis view with per-link metrics and the all-pairs matrix.
export function LinkPanel({
  txs,
  rxs,
  activeTxId,
  activeRxId,
  matrix,
  matrixLoading,
  matrixProgress,
  onSolveMatrix,
  onSelectPair,
  paths,
  metrics,
  hasResult,
  onSolve,
  solving,
  solveError,
  backendOnline,
}: LinkPanelProps) {
  const { t } = useI18n();
  return (
    <div className="panel p-4 flex flex-col gap-4">
      <div className="flex items-center gap-1.5 justify-between">
        <div className="flex items-center gap-1.5">
          <Zap aria-hidden="true" className="w-4 h-4 text-[#cc785c]" />
          <h3 className="panel-title">{t('Link diagnostics', '链路诊断')}</h3>
        </div>
        {hasResult && <span
          className={`text-[11px] px-2.5 py-0.5 rounded font-bold border  ${
            metrics.losStatus === 'LOS'
              ? 'bg-[#5f7f5a]/10 border-[#5f7f5a]/30 text-[#5f7f5a]'
              : 'bg-[#cc785c]/10 border-[#cc785c]/30 text-[#cc785c]'
          }`}
        >
          {t("Link: ", "链路 ")}{metrics.losStatus}
        </span>}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold">
          AP
          <select id="select-diagnostic-tx" className="min-w-0 rounded border border-[var(--line)] bg-white px-2 py-1.5 text-sm"
            value={activeTxId} onChange={event => onSelectPair(event.target.value, activeRxId)}>
            {txs.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold">
          UE
          <select id="select-diagnostic-rx" className="min-w-0 rounded border border-[var(--line)] bg-white px-2 py-1.5 text-sm"
            value={activeRxId} onChange={event => onSelectPair(activeTxId, event.target.value)}>
            {rxs.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
          </select>
        </label>
      </div>
      <button id="btn-solve-link" type="button" onClick={onSolve} disabled={solving || matrixLoading || !backendOnline}
        className="btn-signal flex w-full cursor-pointer items-center justify-center gap-2 px-3 py-2 text-sm disabled:cursor-not-allowed">
        <Zap aria-hidden="true" className={`h-4 w-4 ${solving ? 'animate-pulse' : ''}`} />
        {solving ? t('Tracing rays…', '正在追踪射线…') : t('Run selected link', '计算所选链路')}
      </button>
      {!backendOnline && <p className="text-xs text-slate-600">{t('Solver is offline.', '求解器离线。')}</p>}
      {solveError && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
        {solveError}
      </p>}

      {/* ALL-PAIRS LINK MATRIX — RX power for every Tx→Rx pair.
          Click a cell to focus that pair (shows its multipath in 3D). */}
      {(txs.length > 1 || rxs.length > 1) && (
        <div id="link-matrix" className="flex flex-col gap-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-bold text-slate-700">{t('AP × UE Link Matrix', 'AP × UE 链路矩阵')}</span>
            <span className="text-[11px] text-slate-600 font-mono">{txs.length}×{rxs.length} = {txs.length * rxs.length}{t(" links", " 条链路")}</span>
          </div>
          <button
            id="btn-solve-matrix"
            onClick={onSolveMatrix}
            disabled={matrixLoading || solving || !backendOnline}
            className="w-full bg-[#ebe7dc] hover:bg-[#e3e0d6] disabled:opacity-50 text-slate-900 text-[13px] font-bold py-2 px-3 rounded uppercase tracking-widest flex items-center justify-center gap-2 transition cursor-pointer border border-[#e3e0d6]"
          >
            <Activity className={`w-3.5 h-3.5 ${matrixLoading ? 'animate-spin' : ''}`} />
            {matrixLoading ? (matrixProgress || t('Solving matrix…', "正在计算链路矩阵…")) : t('Solve All Pairs · Sionna RT', "计算所有链路 · Sionna RT")}
          </button>

          {Object.keys(matrix).length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] font-mono border-collapse">
                <thead>
                  <tr className="text-slate-600">
                    <th className="p-1 text-left font-bold sticky left-0 bg-[#f5f3ec]">{t("RX Pwr dBm", "接收功率（dBm）")}</th>
                    {rxs.map((r) => (
                      <th key={r.id} className="p-1 font-bold text-[#4a727e] whitespace-nowrap">{r.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {txs.map((transmitter) => (
                    <tr key={transmitter.id}>
                      <td className="p-1 font-bold text-[#cc785c] whitespace-nowrap sticky left-0 bg-[#f5f3ec]">{transmitter.name}</td>
                      {rxs.map((r) => {
                        const cell = matrix[`${transmitter.id}|${r.id}`];
                        const isActive = transmitter.id === activeTxId && r.id === activeRxId;
                        const p = cell?.metrics.totalRxPowerDbm;
                        const los = cell?.metrics.losStatus === 'LOS';
                        const label = cell ? t(
                          `${transmitter.name} → ${r.name}, ${cell.metrics.losStatus}, ${cell.metrics.numPaths} paths`,
                          `${transmitter.name} → ${r.name}，${cell.metrics.losStatus}，${cell.metrics.numPaths} 条路径`,
                        ) : '';
                        return (
                          <td
                            key={r.id}
                            className={`text-center border ${isActive ? 'border-[#cc785c] bg-[#cc785c]/10' : 'border-[#ebe7dc]'} ${los ? 'text-emerald-700' : 'text-slate-700'}`}
                          >
                            {cell ? (
                              <button
                                type="button"
                                aria-pressed={isActive}
                                aria-label={label}
                                title={label}
                                onClick={() => onSelectPair(transmitter.id, r.id)}
                                className="w-full cursor-pointer p-1 transition hover:bg-[#ebe7dc]"
                              >
                                {p! <= -200 ? '—' : p!.toFixed(1)}
                              </button>
                            ) : '·'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-slate-600 mt-1.5">{t("Green = LOS · click a cell to focus that pair in 3D.", "绿色表示视距链路。点击单元格可在三维场景中定位该链路。")}</p>
            </div>
          )}
        </div>
      )}

      {hasResult && <>
        <div className="grid grid-cols-3 gap-2.5">
          <div className="flex flex-col gap-0.5 bg-[#f5f3ec] p-3 rounded border border-[#e3e0d6]">
            <span className="text-[11px] text-[#6b6862] font-bold">{t("RX Power", "接收功率")}</span>
            <span className="text-[15px] font-bold text-[#141413] font-mono">
              {metrics.totalRxPowerDbm.toFixed(1)} <span className="text-[11px] font-normal text-slate-600">dBm</span>
            </span>
            <span className="text-[11px] text-[#5f7f5a] font-bold font-mono">
              {(Math.pow(10, metrics.totalRxPowerDbm / 10) * 1e6).toFixed(4)} μW
            </span>
          </div>

          <div className="flex flex-col gap-0.5 bg-[#f5f3ec] p-3 rounded border border-[#e3e0d6]">
            <span className="text-[11px] text-[#6b6862] font-bold">{t("Delay Spread", "时延扩展")}</span>
            <span className="text-[15px] font-bold text-[#141413] font-mono">
              {metrics.rmsDelaySpreadValid === false
                ? t('N/A', "不适用")
                : <>{metrics.rmsDelaySpreadNs.toFixed(1)} <span className="text-[11px] font-normal text-slate-600">ns</span></>}
            </span>
            <span className="text-[11px] text-slate-600 font-semibold uppercase">{t("Multipath", "多径")}</span>
          </div>

          <div className="flex flex-col gap-0.5 bg-[#f5f3ec] p-3 rounded border border-[#e3e0d6]">
            <span className="text-[11px] text-[#6b6862] font-bold">{t("Active Rays", "有效路径")}</span>
            <span className="text-[15px] font-bold text-[#141413] font-mono">
              {metrics.numPaths} <span className="text-[11px] font-normal text-slate-600">{t("resolved", "已解析")}</span>
            </span>
            <span className="text-[11px] text-slate-600 font-semibold uppercase">{t("Bounces", "交互次数")}</span>
          </div>
        </div>

        {paths.length > 0 ? <CIRChart paths={paths} /> :
          <p role="status" className="text-sm text-slate-600">{t('The solver found no paths for this link.', '求解器未找到这条链路的传播路径。')}</p>}

        {paths.length > 0 && <div className="mt-1 flex flex-col gap-1.5">
          <h4 className="eyebrow flex items-center gap-1.5">
            <Waves className="w-3.5 h-3.5 text-[#cc785c]" />
            {t("Resolved Ray Propagation Paths", "已解析的传播路径")}
          </h4>

          <div className="max-h-[145px] overflow-y-auto border border-[#e3e0d6] rounded text-[13px] text-[#141413] bg-[#f5f3ec]">
            <table className="w-full text-left font-mono">
              <thead className="bg-[#ffffff] border-b border-[#e3e0d6] text-slate-600 text-[11px] uppercase font-bold sticky top-0">
                <tr>
                  <th className="py-2 px-3">{t("Path Type", "路径类型")}</th>
                  <th className="py-2 px-2">{t("Dist", "距离")}</th>
                  <th className="py-2 px-2">{t("Delay", "时延")}</th>
                  <th className="py-2 px-3 text-right">{t("Rx Power", "接收功率")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e3e0d6]">
                {paths.map((p, idx) => (
                  <tr key={p.id} className="hover:bg-[#ebe7dc]/50 duration-105 font-semibold">
                    <td className="py-1.5 px-3 flex items-center gap-1.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${p.type === 'LOS' ? 'bg-[#5f7f5a]' : 'bg-[#cc785c]'}`}
                      />
                      <span className="font-sans font-bold text-slate-800">
                        {p.type === 'LOS' ? t('LOS Link', '视距路径') : t(`Reflection (W_${idx})`, `反射路径（W_${idx}）`)}
                      </span>
                    </td>
                    <td className="py-1.5 px-2 text-slate-600">{p.distance.toFixed(0)}m</td>
                    <td className="py-1.5 px-2 text-slate-600">{p.delayNs.toFixed(0)}ns</td>
                    <td
                      className={`py-1.5 px-3 text-right ${
                        p.receivedPowerDbm > -65 ? 'text-[#5f7f5a]' : p.receivedPowerDbm > -90 ? 'text-[#4a727e]' : 'text-slate-600'
                      }`}
                    >
                      {p.receivedPowerDbm.toFixed(1)} dBm
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>}
      </>}
    </div>
  );
}
