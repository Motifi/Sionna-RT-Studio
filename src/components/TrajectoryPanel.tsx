/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useI18n } from '../i18n';
import React, { useState, useEffect, useRef } from 'react';
import { GeoAnchor, Transmitter, Receiver, MobilityCombineMode, TrajectoryPoint } from '../types';
import { HandoverAnalysis, HandoverConfig, MobilityExecution, MobilityStep } from '../api';
import { enuToLatLon } from '../utils';
import { Play, Square, Navigation, ArrowLeftRight } from 'lucide-react';

interface TrajectoryPanelProps {
  txs: Transmitter[];
  tx: Transmitter; // active Tx — center of the generated loop path
  rx: Receiver;    // the device that walks the trajectory
  anchor: GeoAnchor;
  trajectoryPoints: TrajectoryPoint[];
  setTrajectoryPoints: (pts: TrajectoryPoint[]) => void;
  mobilitySteps: MobilityStep[];
  mobilityLoading: boolean;
  mobilityProgress: string;
  mobilityExecution: MobilityExecution | null;
  onRunMobility: (speedKmh: number, intervalMs: number) => void;
  onMobilityStepSelect: (step: MobilityStep) => void;
  mobilitySpeedKmh: number;
  setMobilitySpeedKmh: (value: number) => void;
  mobilityIntervalMs: number;
  setMobilityIntervalMs: (value: number) => void;
  mobilityCombineMode: MobilityCombineMode;
  setMobilityCombineMode: (m: MobilityCombineMode) => void;
  // A3 handover parameters (sent with the next run) + the last run's analysis.
  handoverConfig: HandoverConfig;
  setHandoverConfig: (c: HandoverConfig) => void;
  mobilityHandover: HandoverAnalysis | null;
  solveError: string;
  backendOnline: boolean;
}

// 3GPP TS 38.331 timeToTrigger values (ms), abbreviated to the common ones.
const TTT_CHOICES_MS = [0, 40, 80, 160, 320, 480, 640, 1024] as const;

// MOBILITY TRAJECTORY VIEWPORT — draw/generate a path, ray-trace it with
// Sionna RT (all Tx, best-server), scrub/play the solved waypoints.
export function TrajectoryPanel({
  txs,
  tx,
  rx,
  anchor,
  trajectoryPoints,
  setTrajectoryPoints,
  mobilitySteps,
  mobilityLoading,
  mobilityProgress,
  mobilityExecution,
  onRunMobility,
  onMobilityStepSelect,
  mobilitySpeedKmh,
  setMobilitySpeedKmh,
  mobilityIntervalMs,
  setMobilityIntervalMs,
  mobilityCombineMode,
  setMobilityCombineMode,
  handoverConfig,
  setHandoverConfig,
  mobilityHandover,
  solveError,
  backendOnline,
}: TrajectoryPanelProps) {
  const { t } = useI18n();
  const [isSimulatingMobility, setIsSimulatingMobility] = useState(false);
  const [mobilityStep, setMobilityStep] = useState(0);
  const playbackTimerRef = useRef<number | null>(null);
  const playbackStepRef = useRef(0);
  const mobilityStepsRef = useRef(mobilitySteps);
  const trajectoryPointsRef = useRef(trajectoryPoints);
  const rxRef = useRef(rx);
  const mobilitySpeedRef = useRef(mobilitySpeedKmh);
  const onMobilityStepSelectRef = useRef(onMobilityStepSelect);

  mobilityStepsRef.current = mobilitySteps;
  trajectoryPointsRef.current = trajectoryPoints;
  rxRef.current = rx;
  mobilitySpeedRef.current = mobilitySpeedKmh;
  onMobilityStepSelectRef.current = onMobilityStepSelect;

  useEffect(() => {
    playbackStepRef.current = 0;
    setMobilityStep(0);
    if (mobilitySteps.length > 0) {
      stopMobilityPlayback();
    }
  }, [mobilitySteps]);

  useEffect(() => {
    return () => {
      if (playbackTimerRef.current !== null) {
        window.clearInterval(playbackTimerRef.current);
      }
    };
  }, []);

  const stopMobilityPlayback = () => {
    if (playbackTimerRef.current !== null) {
      window.clearInterval(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    setIsSimulatingMobility(false);
  };

  // Generate a standard loop trajectory around the TX node automatically.
  const generateCircularTrajectory = () => {
    const pts: TrajectoryPoint[] = [];
    const steps = 12;
    const radius = 120; // meters

    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const enu = {
        x: tx.enu.x + radius * Math.cos(angle),
        y: tx.enu.y + radius * Math.sin(angle),
        z: rx.height,
      };
      const ll = enuToLatLon(enu, anchor);
      pts.push({ lat: ll.lat, lon: ll.lon, enu });
    }
    stopMobilityPlayback();
    playbackStepRef.current = 0;
    setTrajectoryPoints(pts);
    setMobilityStep(0);
  };

  const applyMobilityFrame = (index: number): boolean => {
    const steps = mobilityStepsRef.current;
    const pts = trajectoryPointsRef.current;
    const frameCount = steps.length || pts.length;
    if (frameCount === 0 || index >= frameCount) return false;

    const step = steps[index];
    const pt = pts[index];
    if (step) {
      onMobilityStepSelectRef.current(step);
    } else if (pt) {
      // No RT solve yet — preview the motion with a synthetic (empty) step.
      // Routing the position through the mobility channel (instead of mutating
      // the Rx device) keeps App's stale-state cleanup from resetting playback.
      onMobilityStepSelectRef.current({
        index,
        rxPosition: { x: pt.enu.x, y: pt.enu.y, z: rxRef.current.height },
        receivedPowerDbm: -200,
        rmsDelaySpreadNs: 0,
        rmsDelaySpreadValid: true,
        numPaths: 0,
        maxDopplerHz: 0,
        losStatus: 'NLOS',
        paths: [],
      });
    }

    playbackStepRef.current = index;
    setMobilityStep(index);
    return true;
  };

  const startMobilityPlayback = () => {
    if (playbackTimerRef.current !== null) {
      window.clearInterval(playbackTimerRef.current);
    }

    const firstIndex = Math.min(playbackStepRef.current, Math.max((mobilityStepsRef.current.length || trajectoryPointsRef.current.length) - 1, 0));
    if (!applyMobilityFrame(firstIndex)) return;
    setIsSimulatingMobility(true);

    const intervalMs = Math.max(40, 3000 / (mobilitySpeedRef.current + 1e-3));
    playbackTimerRef.current = window.setInterval(() => {
      const next = playbackStepRef.current + 1;
      if (!applyMobilityFrame(next)) {
        applyMobilityFrame(0); // loop the trajectory, like the reference app
      }
    }, intervalMs);
  };

  return (
    <div className="panel p-4 flex flex-col gap-4">
      <div className="flex items-center gap-1.5">
        <Navigation className="w-4 h-4 text-[#cc785c]" />
        <h3 className="panel-title">{t("Rx Device Trajectory Simulator", "接收端轨迹仿真")}</h3>
      </div>

      <div className="flex flex-col gap-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-2.5">
        <span className="text-[11px] text-slate-600 font-bold">
          {t('Moving UE', '当前移动的 UE')}
          <span className="ml-1.5 text-slate-900">{rx.name}</span>
        </span>
        <span className="text-[11px] text-slate-500 leading-snug">
          {t(
            'Trajectory tracing follows the selected UE and includes every AP. Use Solve all links in Scene devices to compare all AP–UE pairs at their placed positions.',
            '轨迹追踪只让选中的 UE 移动，并计算它与所有 AP 的链路。「场景设备」中的「计算所有链路」可比较各设备在当前布点位置的静态链路。',
          )}
        </span>
      </div>

      {/* Multi-Tx KPI aggregation toggle — applied on the next Run Mobility.
          Rays drawn are the union of all Tx in both modes; only the per-step
          scalar KPIs differ (strongest Tx vs total power over all Tx). */}
      <div className="flex flex-col gap-1.5 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-2.5">
        <span className="text-[11px] text-slate-600 font-bold">
          {t("Multi-Tx KPI mode", "多发射端指标模式")}{txs.length <= 1 ? t(' · add a 2nd Tx to compare', " · 添加第二个发射端以比较") : ''}
        </span>
        <div className="grid grid-cols-2 gap-1 bg-[#e8e5da] p-1 rounded-lg">
          {([
            { key: 'best_server', label: t('Best-server', "最强信号") },
            { key: 'sum', label: t('Sum power', "功率相加") },
          ] as const).map((opt) => (
            <button
              key={opt.key}
              id={`btn-combine-${opt.key}`}
              onClick={() => setMobilityCombineMode(opt.key)}
              className={`py-1.5 text-[12px] font-bold rounded uppercase tracking-[0.04em] transition cursor-pointer border-0 ${
                mobilityCombineMode === opt.key
                  ? 'bg-white text-[#cc785c] shadow-sm'
                  : 'text-slate-500 hover:text-slate-800 bg-transparent'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-slate-500 leading-snug">
          {mobilityCombineMode === 'best_server'
            ? t('KPIs follow the single strongest transmitter (instantaneous association); the A3 card adds the hysteresis/TTT protocol view on top.', "指标取当前最强发射端。A3 切换另行考虑迟滞与触发时间。")
            : t('RSS is the non-coherent power sum over every transmitter; delay spread remains per-Tx because no inter-cell synchronization is assumed.', "RSS 为各发射端功率的非相干和。假定小区间未同步，时延扩展分别计算。")}
        </span>
      </div>

      {/* A3 handover parameters — applied on the next Run Mobility. The backend
          runs the hysteresis/TTT state machine over the per-Tx RSS series and
          returns the association analysis alongside the raw best-server steps. */}
      {txs.length > 1 && (
        <div className="flex flex-col gap-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-2.5">
          <span className="text-[11px] text-slate-600 font-bold flex items-center gap-1.5">
            <ArrowLeftRight className="w-3 h-3 text-[#cc785c]" />{t(" A3 handover · hysteresis + time-to-trigger", " A3 切换 · 迟滞与触发时间")}
          </span>
          <div className="flex justify-between items-center">
            <span className="text-[11px] font-bold text-slate-600">{t("Hysteresis", "迟滞")}</span>
            <span className="text-[12px] font-bold text-slate-700 font-mono">{handoverConfig.hysteresisDb.toFixed(1)} dB</span>
          </div>
          <input
            type="range" min="0" max="15" step="0.5" className="accent-[#cc785c]"
            value={handoverConfig.hysteresisDb}
            onChange={(e) => setHandoverConfig({ ...handoverConfig, hysteresisDb: parseFloat(e.target.value) })}
          />
          <div className="flex justify-between items-center">
            <span className="text-[11px] font-bold text-slate-600">{t("Time-to-trigger", "触发时间")}</span>
            <select
              value={handoverConfig.timeToTriggerMs}
              onChange={(e) => setHandoverConfig({ ...handoverConfig, timeToTriggerMs: Number(e.target.value) })}
              className="bg-white border border-[#e3e0d6] rounded px-2 py-0.5 font-mono text-[12px] text-slate-800"
            >
              {TTT_CHOICES_MS.map((ms) => <option key={ms} value={ms}>{ms} ms</option>)}
            </select>
          </div>
        </div>
      )}

      {trajectoryPoints.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <p className="text-[14px] text-slate-600 font-medium max-w-xs">
            {t("Draw a receiver path in the 3D scene, or generate a quick loop around the transmitter.", "在三维场景中绘制接收端轨迹，也可以生成一条绕发射端的环形轨迹。")}
          </p>
          <button
            id="btn-gen-trajectory"
            onClick={generateCircularTrajectory}
            className="btn-signal py-2 px-4 rounded text-[14px] font-semibold cursor-pointer"
          >
            {t("Generate Loop Path", "生成环形轨迹")}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Ray-trace the whole trajectory with real Sionna RT */}
          <button
            id="btn-run-mobility"
            onClick={() => onRunMobility(mobilitySpeedKmh, mobilityIntervalMs)}
            disabled={mobilityLoading || !backendOnline}
            className="w-full btn-signal text-[14px] font-bold py-2.5 px-3 rounded uppercase tracking-widest flex items-center justify-center gap-2 transition cursor-pointer border-none"
          >
            <Navigation className={`w-4 h-4 ${mobilityLoading ? 'animate-pulse' : ''}`} />
            {mobilityLoading
              ? (mobilityProgress || t('Tracing sampled path…', "正在追踪采样轨迹…"))
              : !backendOnline
              ? t('Backend offline', "后端离线")
              : mobilitySteps.length
              ? t('Re-run Mobility · Sionna RT', "重新计算移动轨迹 · Sionna RT")
              : t('Run Mobility · Sionna RT', "计算移动轨迹 · Sionna RT")}
          </button>

          {solveError && (
            <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2.5 py-1.5 font-mono">
              {solveError}
            </div>
          )}

          {mobilityExecution && (
            <div className={`text-[11px] font-mono rounded px-2.5 py-1.5 border ${
              mobilityExecution.batchedResultUsed
                ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                : 'text-amber-700 bg-amber-50 border-amber-200'
            }`}>
              {mobilityExecution.batchedResultUsed
                ? t(
                  `Verified single PathSolver dispatch · ${mobilityExecution.pairCount} pairs · ${mobilityExecution.solveTimeMs.toFixed(1)} ms`,
                  `单次 PathSolver 调用 · ${mobilityExecution.pairCount} 条链路 · ${mobilityExecution.solveTimeMs.toFixed(1)} ms`,
                )
                : t(
                  `Serial fallback used · ${mobilityExecution.successfulPathSolverDispatches} dispatches · ${mobilityExecution.solveTimeMs.toFixed(1)} ms`,
                  `使用串行求解 · ${mobilityExecution.successfulPathSolverDispatches} 次调用 · ${mobilityExecution.solveTimeMs.toFixed(1)} ms`,
                )}
            </div>
          )}

          {/* A3 handover analysis for the last run (≥ 2 Tx). Events are
              clickable — they jump the scrubber to the handover waypoint. */}
          {mobilityHandover && mobilitySteps.length > 0 && (
            <div className="flex flex-col gap-2 border border-[#e3e0d6] rounded p-2.5 bg-[#faf9f5]">
              <span className="text-[11px] text-slate-600 font-bold flex items-center gap-1.5">
                <ArrowLeftRight className="w-3 h-3 text-[#cc785c]" />
                {t("A3 handovers · ", "A3 切换 · ")}{mobilityHandover.hysteresisDb.toFixed(1)} dB / {mobilityHandover.timeToTriggerMs.toFixed(0)} ms
              </span>
              <div className="grid grid-cols-3 gap-2 text-center">
                {([
                  [t('A3 handovers', "A3 切换"), String(mobilityHandover.handoverCount)],
                  [t('Ping-pongs', "乒乓切换"), String(mobilityHandover.pingPongCount)],
                  [t('Raw switches', "瞬时切换"), String(mobilityHandover.instantaneousChangeCount)],
                ] as const).map(([lab, val]) => (
                  <div key={lab} className="flex flex-col gap-0.5 bg-white border border-[#e3e0d6] rounded py-1.5">
                    <span className="text-[11px] text-slate-500 font-bold">{lab}</span>
                    <span className="font-mono text-[13px] font-bold text-slate-800">{val}</span>
                  </div>
                ))}
              </div>
              {mobilityHandover.events.length > 0 && (
                <div className="flex flex-col gap-1 max-h-28 overflow-y-auto">
                  {mobilityHandover.events.map((e, i) => (
                    <button
                      key={i}
                      onClick={() => { stopMobilityPlayback(); applyMobilityFrame(e.stepIndex); }}
                      className="flex items-center justify-between text-[12px] font-mono bg-white border border-[#e3e0d6] rounded px-2 py-1 cursor-pointer hover:border-[#cc785c] transition text-left"
                    >
                      <span className="text-slate-700">
                        t={e.timeS.toFixed(1)}{t("s · wp ", "s · 航点 ")}{e.stepIndex + 1} · {e.fromTxName} → <strong>{e.toTxName}</strong>
                      </span>
                      {e.pingPong && <span className="text-[11px] font-bold text-amber-600 uppercase">{t("ping-pong", "乒乓切换")}</span>}
                    </button>
                  ))}
                </div>
              )}
              {mobilityHandover.servingTxIds[mobilityStep] != null && (
                <span className="text-[11px] text-slate-500 font-mono">
                  {t("A3 serving @ wp ", "A3 服务端 · 航点 ")}{mobilityStep + 1}: {txs.find((t) => t.id === mobilityHandover.servingTxIds[mobilityStep])?.name ?? mobilityHandover.servingTxIds[mobilityStep]}
                </span>
              )}
            </div>
          )}

          {/* Step scrubber — drag to inspect any solved position */}
          {(mobilitySteps.length > 0 || trajectoryPoints.length > 1) && (
            <input
              type="range"
              id="slider-mobility-step"
              min="0"
              max={Math.max((mobilitySteps.length || trajectoryPoints.length) - 1, 0)}
              step="1"
              className="accent-[#cc785c] cursor-ew-resize"
              value={mobilityStep}
              onChange={(e) => {
                stopMobilityPlayback();
                applyMobilityFrame(parseInt(e.target.value, 10));
              }}
            />
          )}

          <div className="flex items-center gap-2">
            <button
              id="btn-playback-toggle"
              onClick={() => {
                if (isSimulatingMobility) {
                  stopMobilityPlayback();
                } else {
                  startMobilityPlayback();
                }
              }}
              disabled={mobilitySteps.length === 0 && trajectoryPoints.length < 2}
              aria-label={isSimulatingMobility ? t('Stop playback', '停止播放') : t('Play trajectory', '播放轨迹')}
              className="btn-signal p-3 rounded-lg cursor-pointer"
            >
              {isSimulatingMobility ? <Square className="w-4 h-4 fill-white" /> : <Play className="w-4 h-4 fill-white" />}
            </button>

            <div className="flex-1 flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <span className="text-[11px] font-bold text-slate-600">
                  {t("Way: ", "航点 ")}{mobilityStep + 1} / {mobilitySteps.length || trajectoryPoints.length}
                </span>
                <span className="text-[12px] font-bold text-slate-700 font-mono">{mobilitySpeedKmh} km/h</span>
              </div>
              <input
                type="range"
                min="10"
                max="120"
                step="5"
                className="accent-[#cc785c]"
                value={mobilitySpeedKmh}
                onChange={(e) => setMobilitySpeedKmh(parseInt(e.target.value, 10))}
              />
              <div className="flex justify-between items-center">
                <span className="text-[11px] font-bold text-slate-600">{t("RT Sample Interval", "射线追踪采样间隔")}</span>
                <span className="text-[12px] font-bold text-slate-700 font-mono">{mobilityIntervalMs} ms</span>
              </div>
              <input
                type="range"
                min="25"
                max="500"
                step="25"
                className="accent-[#5f7f5a]"
                value={mobilityIntervalMs}
                onChange={(e) => setMobilityIntervalMs(parseInt(e.target.value, 10))}
              />
            </div>
          </div>

          {/* Real per-waypoint Sionna metrics */}
          {(() => {
            const step = mobilitySteps[mobilityStep];
            if (!step) {
              return (
                <div className="text-[12px] text-slate-600 text-center border border-[#e3e0d6] rounded p-3 bg-[#f5f3ec]">
                  {t("Press ", "点击 ")}<strong className="text-[#cc785c]">{t("Play", "播放")}</strong>{t(" to preview the receiver moving along the path, or ", " 可预览接收端移动。点击 ")}<strong className="text-[#cc785c]">{t("Run Mobility", "计算移动轨迹")}</strong>{t(" to ray-trace it with Sionna RT for per-waypoint metrics.", " 可用 Sionna RT 计算逐航点指标。")}
                </div>
              );
            }
            const perTx = step.perTx ?? [];
            const multiTx = perTx.length > 1;
            // Sum mode leaves servingTxName unset but still has rays/coverage.
            const isCombined = multiTx && !step.servingTxName && step.numPaths > 0;
            const powerLabel = !multiTx ? t('Rx Power', "接收功率") : step.servingTxName ? t('Serving RSS', "服务链路 RSS") : t('Combined RSS', "合计 RSS");
            return (
              <div className="flex flex-col gap-2">
                {multiTx && step.servingTxName && (
                  <div className="flex items-center justify-between bg-[#f8f1ec] px-2.5 py-1.5 rounded border border-[#ecd9c9]">
                    <span className="text-[11px] text-slate-600 font-bold">{t("Serving Tx · Best Server", "服务发射端 · 最强信号")}</span>
                    <span className="font-mono font-bold text-[#cc785c] text-[13px]">{step.servingTxName}</span>
                  </div>
                )}
                {isCombined && (
                  <div className="flex items-center justify-between bg-[#f8f1ec] px-2.5 py-1.5 rounded border border-[#ecd9c9]">
                    <span className="text-[11px] text-slate-600 font-bold">{t("Combined · Sum Power", "合计 · 功率相加")}</span>
                    <span className="font-mono font-bold text-[#cc785c] text-[13px]">{perTx.length}{t(" Tx", " 个发射端")}</span>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 text-[13px]">
                  <div className="flex flex-col gap-0.5 bg-[#f5f3ec] p-2.5 rounded border border-[#e3e0d6]">
                    <span className="text-[11px] text-slate-600 font-bold">{powerLabel}</span>
                    <span className="font-mono font-bold text-[#141413]">{step.receivedPowerDbm.toFixed(1)} dBm</span>
                  </div>
                  <div className="flex flex-col gap-0.5 bg-[#f5f3ec] p-2.5 rounded border border-[#e3e0d6]">
                    <span className="text-[11px] text-slate-600 font-bold">{t("Doppler (RT)", "多普勒频移（射线追踪）")}</span>
                    <span className="font-mono font-bold text-[#cc785c]">{step.maxDopplerHz.toFixed(0)} Hz</span>
                  </div>
                  <div className="flex flex-col gap-0.5 bg-[#f5f3ec] p-2.5 rounded border border-[#e3e0d6]">
                    <span className="text-[11px] text-slate-600 font-bold">{t("Delay Spread", "时延扩展")}</span>
                    <span className="font-mono font-bold text-[#141413]">
                      {step.rmsDelaySpreadValid === false ? t('N/A (per-Tx only)', "不适用（仅逐发射端计算）") : `${step.rmsDelaySpreadNs.toFixed(1)} ns`}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5 bg-[#f5f3ec] p-2.5 rounded border border-[#e3e0d6]">
                    <span className="text-[11px] text-slate-600 font-bold">{t("Link · Rays", "链路 · 路径数")}</span>
                    <span className={`font-mono font-bold ${step.losStatus === 'LOS' ? 'text-[#5f7f5a]' : 'text-[#cc785c]'}`}>
                      {step.losStatus} · {step.numPaths}
                    </span>
                  </div>
                </div>
                {multiTx && (
                  <div className="flex flex-col gap-1 border border-[#e3e0d6] rounded p-2 bg-[#faf9f5]">
                    <span className="text-[11px] text-slate-600 font-bold mb-0.5">{t("All Transmitters · RSS @ this waypoint", "当前航点的各发射端 RSS")}</span>
                    {perTx.map((t) => {
                      const isServing = t.txId === step.servingTxId;
                      return (
                        <div key={t.txId} className="flex items-center justify-between text-[12px] font-mono">
                          <span className={isServing ? 'font-bold text-[#cc785c]' : 'text-slate-700'}>
                            {isServing ? '▶ ' : '  '}{t.txName}
                          </span>
                          <span className="flex items-center gap-2">
                            <span className={t.losStatus === 'LOS' ? 'text-[#5f7f5a]' : 'text-slate-400'}>{t.losStatus}</span>
                            <span className={`font-bold ${t.receivedPowerDbm > -90 ? 'text-[#141413]' : 'text-slate-400'}`}>
                              {t.receivedPowerDbm > -200 ? `${t.receivedPowerDbm.toFixed(1)} dBm` : '—'}
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
