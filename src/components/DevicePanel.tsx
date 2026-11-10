/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Radio } from 'lucide-react';
import { useI18n } from '../i18n';
import type { Receiver, Transmitter } from '../types';
import { DeviceRow } from './DeviceRow';

interface DevicePanelProps {
  txs: Transmitter[];
  rxs: Receiver[];
  activeTxId: string;
  activeRxId: string;
  onSelectTx: (id: string) => void;
  onSelectRx: (id: string) => void;
  onRemoveTx: (id: string) => void;
  onRemoveRx: (id: string) => void;
  onAddTx: () => void;
  onAddRx: () => void;
}

export function DevicePanel({
  txs, rxs, activeTxId, activeRxId,
  onSelectTx, onSelectRx, onRemoveTx, onRemoveRx, onAddTx, onAddRx,
}: DevicePanelProps) {
  const { t } = useI18n();
  return (
    <section id="device-panel" aria-labelledby="device-panel-title" className="panel flex shrink-0 flex-col gap-3 p-4">
      <h3 id="device-panel-title" className="panel-title flex items-center gap-1.5">
        <Radio aria-hidden="true" className="h-4 w-4 text-[#cc785c]" />
        {t('Scene devices', '场景设备')}
      </h3>
      <DeviceRow kind="tx" list={txs} activeId={activeTxId} onSelect={onSelectTx} onRemove={onRemoveTx} onAdd={onAddTx} />
      <DeviceRow kind="rx" list={rxs} activeId={activeRxId} onSelect={onSelectRx} onRemove={onRemoveRx} onAdd={onAddRx} />
      <p className="text-[12px] leading-snug text-slate-600">
        {t(
          'Choose Add, then click the 3D scene to place one or more devices. Press Esc to finish. Select a device here to edit or move it.',
          '点击「新增」，再在三维场景中连续点击布点，按 Esc 结束。点选列表中的设备可编辑或移动它。',
        )}
      </p>
    </section>
  );
}
