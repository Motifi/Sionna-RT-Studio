/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useI18n } from '../i18n';

interface DeviceRowProps {
  kind: 'tx' | 'rx';
  list: { id: string; name: string }[];
  activeId: string;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

export function DeviceRow({ kind, list, activeId, onSelect, onRemove, onAdd }: DeviceRowProps) {
  const { t } = useI18n();
  const transmitter = kind === 'tx';
  const label = transmitter ? t('APs (Tx)', '发射端 AP (Tx)') : t('UEs (Rx)', '接收端 UE (Rx)');
  const addLabel = transmitter ? t('+ Add AP', '+ 新增 AP') : t('+ Add UE', '+ 新增 UE');
  const dotClass = transmitter ? 'bg-[#cc785c]' : 'bg-[#4a727e]';

  return (
    <div data-device-type={kind} role="group" aria-label={label} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-bold text-slate-700">
          {label}<span className="ml-1.5 font-mono text-slate-500" data-device-count={list.length}>{list.length}</span>
        </span>
        <button
          id={`btn-panel-add-${kind}`}
          type="button"
          onClick={onAdd}
          className="shrink-0 cursor-pointer rounded border border-[#e3e0d6] bg-white px-2 py-1 text-[12px] font-bold text-slate-700 transition hover:border-[#cc785c] hover:text-[#a9563b]"
        >
          {addLabel}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {list.map((device) => {
          const active = device.id === activeId;
          return (
            <div
              key={device.id}
              className={`flex max-w-full items-center rounded border text-[12px] font-bold transition ${
                active ? 'border-[#cc785c] bg-[#ebe7dc] text-slate-900' : 'border-[#e3e0d6] bg-white text-slate-600'
              }`}
            >
              <button
                type="button"
                data-device-id={device.id}
                aria-pressed={active}
                onClick={() => onSelect(device.id)}
                className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded px-2 py-1 hover:text-slate-900"
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
