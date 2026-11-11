/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ChevronDown, FileDown, FileUp, FolderOpen, RotateCcw } from 'lucide-react';
import type { BackendHealth } from '../api';
import { createProjectDocument, type ProjectAutosaveStatus, type StudioProjectState } from '../project';
import { AboutStudio } from './AboutStudio';
import { downloadFile } from './downloadFile';
import { useI18n, type LocalizedText } from '../i18n';

const LOGO_URL = new URL('../../assets/logo-app-bone.png', import.meta.url).href;

interface TopNavProps {
  health: BackendHealth | null;
  autosaveStatus: ProjectAutosaveStatus;
  onRetryAutosave: () => void;
  onReplaceUnreadableAutosave?: () => void;
  recoveryError?: string;
  projectState: StudioProjectState;
  onImportProject: (text: string) => void;
  onResetProject: () => void;
}

export function TopNav({
  health, autosaveStatus, onRetryAutosave, onReplaceUnreadableAutosave, recoveryError,
  projectState, onImportProject, onResetProject,
}: TopNavProps) {
  const { t, locale, setLocale } = useI18n();
  const projectMenu = useRef<HTMLDetailsElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const [projectImporting, setProjectImporting] = useState(false);
  const [projectMessage, setProjectMessage] = useState<{ kind: 'success' | 'error'; text: LocalizedText } | null>(null);

  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      const menu = projectMenu.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      const menu = projectMenu.current;
      if (!menu?.open || event.key !== 'Escape') return;
      menu.open = false;
      menu.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, []);

  const saveProjectFile = () => {
    try {
      downloadFile(
        `${JSON.stringify(createProjectDocument(projectState), null, 2)}\n`,
        'sionna_rt_studio_project.json',
        'application/json',
      );
      setProjectMessage({ kind: 'success', text: ['Project file exported.', '项目文件已导出。'] });
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : '';
      setProjectMessage({
        kind: 'error',
        text: [`Could not export the project file.${detail}`, `无法导出项目文件。${detail}`],
      });
    }
  };

  const importProjectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || projectImporting) return;
    setProjectImporting(true);
    setProjectMessage(null);
    try {
      onImportProject(await file.text());
      setProjectMessage({
        kind: 'success',
        text: [`Loaded ${file.name}. Computed results were cleared.`, `已载入 ${file.name}。已清除旧的计算结果。`],
      });
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : '';
      setProjectMessage({
        kind: 'error',
        text: [`Could not import the project file.${detail}`, `无法导入项目文件。${detail}`],
      });
    } finally {
      setProjectImporting(false);
    }
  };

  const menuAction = 'flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm font-semibold hover:bg-[var(--ink-750)] disabled:cursor-wait disabled:opacity-60';

  return (
    <header className="sticky top-0 z-50 shrink-0 border-b border-[var(--line)] bg-[var(--page)]/95 backdrop-blur-md">
      <div className="flex flex-wrap items-center justify-between gap-x-3 px-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5 py-1.5">
          <img
            src={LOGO_URL}
            alt={t('SionnaRT Studio wireless digital twin', 'SionnaRT Studio 无线仿真实验台')}
            className="h-11 w-auto select-none"
            draggable={false}
          />
          <span className="hidden readout text-[12px] text-[var(--text-lo)] sm:inline">{health?.appVersion ? `v${health.appVersion}` : ''}</span>
          <details ref={projectMenu}>
            <summary id="project-menu-trigger" className="btn-quiet flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-sm [&::-webkit-details-marker]:hidden">
              <FolderOpen size={15} aria-hidden="true" />
              {t('Project', '项目')}
              <ChevronDown size={14} aria-hidden="true" />
            </summary>
            <div className="absolute inset-x-3 top-full z-20 grid gap-1 rounded-lg border border-[var(--line)] bg-white p-2 shadow-lg sm:inset-x-auto sm:left-6 sm:w-72">
              <button id="btn-export-project" type="button" className={menuAction} onClick={saveProjectFile}>
                <FileDown size={16} aria-hidden="true" />
                {t('Export project JSON', '导出项目 JSON')}
              </button>
              <button id="btn-import-project" type="button" className={menuAction} disabled={projectImporting} onClick={() => projectInput.current?.click()}>
                <FileUp size={16} aria-hidden="true" />
                {projectImporting ? t('Importing project…', '正在导入项目…') : t('Import project JSON', '导入项目 JSON')}
              </button>
              <input
                id="input-import-project"
                ref={projectInput}
                type="file"
                accept=".json,application/json"
                onChange={importProjectFile}
                className="hidden"
                aria-label={t('Import SionnaRTStudio project JSON', '导入 SionnaRTStudio 项目 JSON')}
              />
              <button
                id="btn-reset-project"
                type="button"
                className={`${menuAction} text-[var(--bad)]`}
                disabled={projectImporting}
                onClick={onResetProject}
              >
                <RotateCcw size={16} aria-hidden="true" />
                {t('Reset Studio', '重置实验台')}
              </button>
              {projectMessage && <p
                role={projectMessage.kind === 'error' ? 'alert' : 'status'}
                className={`border-t border-[var(--line)] px-2 py-1.5 text-xs break-words ${projectMessage.kind === 'error' ? 'text-[var(--bad)]' : 'text-[var(--text-mid)]'}`}
              >{t(...projectMessage.text)}</p>}
            </div>
          </details>
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
        <div className="flex flex-wrap items-center gap-x-2 border-t border-[var(--line)] px-3 py-1 text-xs text-[var(--bad)] sm:px-6">
          <span role="status">{t('Autosave unavailable. Export the project to keep your changes.', '自动保存不可用。请导出项目以保留修改。')}</span>
          {onReplaceUnreadableAutosave && (
            <button type="button" className="font-semibold underline underline-offset-2" onClick={onReplaceUnreadableAutosave}>
              {t('Replace unreadable autosave', '替换无法读取的自动存档')}
            </button>
          )}
          {recoveryError && <span role="alert" className="basis-full">{recoveryError}</span>}
        </div>
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
