/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useI18n } from '../i18n';

const LOGO_URL = new URL('../../assets/logo-app-bone.png', import.meta.url).href;

interface TopNavProps {
  backendOnline: boolean;
  version?: string;
}

export function TopNav({ backendOnline, version = '1.0.0' }: TopNavProps) {
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
          <span className="hidden readout text-[12px] text-[var(--text-lo)] sm:inline">v{version}</span>
        </div>

        <div className="flex shrink-0 items-center gap-2 py-2 select-none">
          <span className="w-1.5 h-1.5 rounded-full" aria-hidden="true" style={{ background: backendOnline ? 'var(--ok)' : 'var(--bad)' }} />
          <span className="readout text-[13px] text-[var(--text-mid)]" role="status">
            <span className="hidden text-[var(--text-lo)] sm:inline">Sionna RT </span>
            {backendOnline ? t('ready', '已就绪') : t('offline', '离线')}
          </span>
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
    </header>
  );
}
