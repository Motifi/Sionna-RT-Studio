import React from 'react';
import { Download, Map, RadioTower, Waves } from 'lucide-react';
import { useI18n } from '../i18n';
import type { StudioWorkspace } from '../project';

const WORKSPACES = [
  { id: 'scene', en: 'Scene', zh: '场景', icon: Map },
  { id: 'planning', en: 'Deployment', zh: '部署', icon: RadioTower },
  { id: 'preview', en: 'Simulation', zh: '仿真', icon: Waves },
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
      className="z-20 shrink-0 border-t border-[var(--line)] bg-[var(--ink-850)] px-2 sm:px-6"
      aria-label={t('Simulation workflow', '仿真工作区')}
    >
      <div className="mx-auto grid w-full max-w-[720px] grid-cols-4 gap-1 sm:gap-2">
        {WORKSPACES.map(({ id, en, zh, icon: Icon }) => {
          const selected = activeWorkspace === id;
          return (
            <button
              key={id}
              id={`nav-btn-${id}`}
              type="button"
              aria-current={selected ? 'page' : undefined}
              onClick={() => onSelect(id)}
              className={`flex min-h-12 min-w-0 cursor-pointer items-center justify-center gap-1.5 border-b-2 px-1 py-1.5 text-xs font-semibold transition-colors sm:gap-2 sm:px-3 sm:text-sm ${
                selected
                  ? 'border-[var(--accent-deep)] bg-[var(--accent-soft)] text-[var(--accent-deep)]'
                  : 'border-transparent text-[var(--text-mid)] hover:bg-[var(--ink-800)] hover:text-[var(--text-hi)]'
              }`}
            >
              <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span>{t(en, zh)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
