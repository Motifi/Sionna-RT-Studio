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
  selectedKind: 'tx' | 'rx';
  onSelectTx: (id: string) => void;
  onSelectRx: (id: string) => void;
  onRemoveTx: (id: string) => void;
  onRemoveRx: (id: string) => void;
}

export function DevicePanel({
  txs, rxs, activeTxId, activeRxId, selectedKind,
  onSelectTx, onSelectRx, onRemoveTx, onRemoveRx,
}: DevicePanelProps) {
  const { t } = useI18n();
  return (
    <section id="device-panel" aria-labelledby="device-panel-title" className="panel flex shrink-0 flex-col gap-3 p-4">
      <h3 id="device-panel-title" className="panel-title flex items-center gap-1.5">
        <Radio aria-hidden="true" className="h-4 w-4 text-[#cc785c]" />
        {t('Devices', '设备')}
      </h3>
      <DeviceRow kind="tx" list={txs} activeId={selectedKind === 'tx' ? activeTxId : null} onSelect={onSelectTx} onRemove={onRemoveTx} />
      <DeviceRow kind="rx" list={rxs} activeId={selectedKind === 'rx' ? activeRxId : null} onSelect={onSelectRx} onRemove={onRemoveRx} />
    </section>
  );
}
