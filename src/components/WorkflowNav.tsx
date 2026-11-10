import React from 'react';
import { Download, Map, RadioTower, Waves } from 'lucide-react';
import { useI18n } from '../i18n';
import type { StudioWorkspace } from '../project';

const WORKSPACES = [
  { id: 'scene', en: 'Scene', zh: '场景', icon: Map },
  { id: 'planning', en: 'Planning', zh: '规划', icon: RadioTower },
  { id: 'preview', en: 'Preview', zh: '预览', icon: Waves },
  { id: 'export', en: 'Export', zh: '导出', icon: Download },
] as const;

interface WorkflowNavProps {
  activeWorkspace: StudioWorkspace;
  onSelect: (workspace: StudioWorkspace) => void;
}

export function WorkflowNav({ activeWorkspace, onSelect }: WorkflowNavProps) {
  const { t } = useI18n();

  return (
    <nav
      className="sticky bottom-0 z-50 shrink-0 border-t border-[var(--line)] bg-[var(--page)]/95 px-2 py-1.5 backdrop-blur-md sm:px-6"
      aria-label={t('Simulation workflow', '仿真工作区')}
    >
      <div className="mx-auto grid w-full max-w-[680px] grid-cols-4 gap-1 sm:gap-2">
        {WORKSPACES.map(({ id, en, zh, icon: Icon }, index) => {
          const selected = activeWorkspace === id;
          return (
            <button
              key={id}
              id={`nav-btn-${id}`}
              type="button"
              aria-current={selected ? 'page' : undefined}
              onClick={() => onSelect(id)}
              className={`flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-1 py-1.5 text-xs font-semibold transition-colors sm:gap-2 sm:px-3 sm:text-sm ${
                selected
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-deep)]'
                  : 'border-transparent text-[var(--text-mid)] hover:border-[var(--line)] hover:bg-white hover:text-[var(--text-hi)]'
              }`}
            >
              <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span className="hidden readout opacity-65 sm:inline">{index + 1}</span>
              <span>{t(en, zh)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
