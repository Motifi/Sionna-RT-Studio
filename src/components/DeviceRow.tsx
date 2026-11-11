/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useI18n } from '../i18n';

interface DeviceRowProps {
  kind: 'tx' | 'rx';
  list: { id: string; name: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}

export function DeviceRow({ kind, list, activeId, onSelect, onRemove }: DeviceRowProps) {
  const { t } = useI18n();
  const transmitter = kind === 'tx';
  const label = transmitter ? t('Access points', '接入点 AP') : t('User equipment', '终端 UE');
  const dotClass = transmitter ? 'bg-[#cc785c]' : 'bg-[#4a727e]';

  return (
    <div data-device-type={kind} role="group" aria-label={label} className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-slate-700">
        {label}<span className="ml-2 readout text-[var(--text-mid)]" data-device-count={list.length}>{list.length}</span>
      </span>
      <div className="grid gap-1">
        {list.map((device) => {
          const active = device.id === activeId;
          return (
            <div
              key={device.id}
              className={`flex min-w-0 items-center rounded border text-sm font-semibold ${
                active ? 'border-[var(--accent-deep)] bg-[var(--accent-soft)] text-slate-900' : 'border-[var(--line)] bg-white text-slate-700'
              }`}
            >
              <button
                type="button"
                data-device-id={device.id}
                aria-pressed={active}
                onClick={() => onSelect(device.id)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--ink-750)]"
              >
                <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
                <span className="truncate" title={device.name}>{device.name}</span>
              </button>
              {list.length > 1 && (
                <button
                  type="button"
                  aria-label={t(`Remove ${device.name}`, `移除 ${device.name}`)}
                  onClick={() => onRemove(device.id)}
                  className="shrink-0 cursor-pointer rounded px-1.5 py-1 leading-none text-slate-600 hover:text-red-600"
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
