/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BackendHealth } from '../api';
import type { ProjectAutosaveStatus } from '../project';
import { AboutStudio } from './AboutStudio';
import { useI18n } from '../i18n';

const LOGO_URL = new URL('../../assets/logo-app-bone.png', import.meta.url).href;

interface TopNavProps {
  health: BackendHealth | null;
  autosaveStatus: ProjectAutosaveStatus;
  onRetryAutosave: () => void;
}

export function TopNav({ health, autosaveStatus, onRetryAutosave }: TopNavProps) {
  const { t, locale, setLocale } = useI18n();

  return (
    <header className="sticky top-0 z-50 shrink-0 border-b border-[var(--line)] bg-[var(--page)]/95 backdrop-blur-md">
      <div className="flex items-center justify-between gap-3 px-3 sm:px-6">
        <div className="flex shrink-0 items-center gap-2.5 py-1.5">
          <img
            src={LOGO_URL}
            alt={t('SionnaRT Studio wireless digital twin', 'SionnaRT Studio 无线仿真实验台')}
            className="h-11 w-auto select-none"
            draggable={false}
          />
          <span className="hidden readout text-[12px] text-[var(--text-lo)] sm:inline">{health?.appVersion ? `v${health.appVersion}` : ''}</span>
        </div>

        <div className="flex shrink-0 items-center gap-2 py-2 select-none">
          <details className="relative">
            <summary className="cursor-pointer readout text-xs" aria-label={t('Solver details', '求解后端详情')}>
              <span role="status">{health?.backend ?? t('Solver offline', '求解器离线')}</span>
            </summary>
            <div className="absolute right-0 top-8 w-72 max-w-[80vw] rounded border border-[var(--line)] bg-[var(--page)] p-3 shadow-lg text-xs space-y-2">
              <p>{t('Selected solver', '已选求解后端')} · {health?.variant ?? '—'}</p>
              <p>{t('Device', '设备型号')} · {health?.deviceModel ?? t('Unavailable', '无法确认')}</p>
              <p>Sionna RT {health?.sionnaRtVersion ?? '—'} · Mitsuba {health?.mitsubaVersion ?? '—'}</p>
              <p>Dr.Jit {health?.drjitVersion ?? '—'} · Python {health?.pythonVersion ?? '—'}</p>
              {!!health?.fallbackReasons?.length && <div>
                <p>{t('Backend selection diagnostics', '后端选择诊断')}</p>
                {health.fallbackReasons.map(reason => <p key={reason} className="break-words text-[var(--text-lo)]">{reason}</p>)}
              </div>}
              {health?.activeSolve && <p>{t('Running', '求解中')} · {health.activeSolve.operation}</p>}
              <p>{t('Last solve', '最近一次求解')} · {health?.lastSolve
                ? (health.lastSolve.status === 'succeeded' ? t('Succeeded', '已通过') : t('Failed', '失败'))
                : t('Awaiting a real solve', '等待真实求解验证')}</p>
              {health?.lastSolve && <p className="break-words">
                {health.lastSolve.operation} · {new Date(health.lastSolve.finishedAt ?? health.lastSolve.startedAt).toLocaleString()}
                {health.lastSolve.error && <span className="block text-[var(--bad)]">{health.lastSolve.error}</span>}
              </p>}
            </div>
          </details>
          <AboutStudio health={health} />
          <select
            data-studio-language=""
            aria-label={t('Interface language', '界面语言')}
            title={t('Interface language', '界面语言')}
            value={locale}
            onChange={(event) => setLocale(event.target.value === 'en' ? 'en' : 'zh')}
            className="ml-1 rounded border border-[var(--line)] bg-[var(--page)] px-2 py-1.5 text-[13px] text-[var(--text-hi)]"
          >
            <option value="zh" lang="zh-CN">简体中文</option>
            <option value="en" lang="en">English</option>
          </select>
        </div>
      </div>
      {autosaveStatus === 'disabled' ? (
        <p role="status" className="border-t border-[var(--line)] px-3 py-1 text-xs text-[var(--bad)] sm:px-6">
          {t('Autosave unavailable. Export the project to keep your changes.', '自动保存不可用。请导出项目以保留修改。')}
        </p>
      ) : autosaveStatus === 'error' ? (
        <div className="flex items-center gap-2 border-t border-[var(--line)] px-3 py-1.5 text-xs text-[var(--bad)] sm:px-6">
          <span role="alert">{t('Project autosave failed.', '项目自动保存失败。')}</span>
          <button type="button" className="font-semibold underline underline-offset-2" onClick={onRetryAutosave}>
            {t('Retry save', '重试保存')}
          </button>
        </div>
      ) : (
        <p role="status" className="border-t border-[var(--line)] px-3 py-1 text-xs text-[var(--text-lo)] sm:px-6">
          {autosaveStatus === 'saving' ? t('Saving project…', '正在保存项目…') : t('Project saved locally', '项目已保存到本机')}
        </p>
      )}
    </header>
  );
}
