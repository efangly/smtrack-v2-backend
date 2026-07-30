import { Probes } from '../../generated/prisma/client';
import { DeviceChangeActor } from './device-changed.event';

export type ProbeChangeAction = 'created' | 'updated' | 'deleted';

/** payload ของ event `probe.changed` — ส่ง probe ทั้งก้อนไปด้วยเสมอ เหมือน device.changed */
export interface ProbeChangedEvent {
  action: ProbeChangeAction;
  probeId: string;
  deviceId: string;
  probe: Probes;
  at: string;
  /** ผู้ใช้ที่ทำ action นี้ — undefined ถ้าเป็น system-triggered */
  actor?: DeviceChangeActor;
}

export function buildProbeChangedEvent(
  action: ProbeChangeAction,
  probe: Probes,
  actor?: DeviceChangeActor,
): ProbeChangedEvent {
  return {
    action,
    probeId: probe.id,
    deviceId: probe.deviceId,
    probe,
    at: new Date().toISOString(),
    ...(actor ? { actor } : {}),
  };
}
