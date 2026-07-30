import { Configs } from '../../generated/prisma/client';
import { DeviceChangeActor } from './device-changed.event';

export type ConfigChangeAction = 'created' | 'updated' | 'deleted';

/** payload ของ event `config.changed` — ส่ง config ทั้งก้อนไปด้วยเสมอ เหมือน device.changed */
export interface ConfigChangedEvent {
  action: ConfigChangeAction;
  configId: string;
  deviceId: string;
  config: Configs;
  at: string;
  /** ผู้ใช้ที่ทำ action นี้ — undefined ถ้าเป็น system-triggered */
  actor?: DeviceChangeActor;
}

export function buildConfigChangedEvent(
  action: ConfigChangeAction,
  config: Configs,
  actor?: DeviceChangeActor,
): ConfigChangedEvent {
  return {
    action,
    configId: config.id,
    deviceId: config.deviceId,
    config,
    at: new Date().toISOString(),
    ...(actor ? { actor } : {}),
  };
}
