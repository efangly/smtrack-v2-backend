import { Test, TestingModule } from '@nestjs/testing';
import { UserAuditListener } from './user-audit.listener';
import { UserAuditService } from './user-audit.service';
import { DeviceChangedEvent } from '../common/events/device-changed.event';
import { ProbeChangedEvent } from '../common/events/probe-changed.event';
import { ConfigChangedEvent } from '../common/events/config-changed.event';
import { RepairChangedEvent } from '../common/events/repair-changed.event';
import { WarrantyChangedEvent } from '../common/events/warranty-changed.event';

describe('UserAuditListener', () => {
  let listener: UserAuditListener;
  let userAudit: { record: jest.Mock };

  const actor = { id: 'user-1', name: 'Somchai', role: 'ADMIN' };

  beforeEach(async () => {
    userAudit = { record: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UserAuditListener, { provide: UserAuditService, useValue: userAudit }],
    }).compile();

    listener = module.get(UserAuditListener);
  });

  it('handleDeviceChanged บันทึกเมื่อ event มี actor', async () => {
    const device = { id: 'dev-1', staticName: 'OPD-01' };
    const event: DeviceChangedEvent = {
      action: 'updated',
      deviceId: 'dev-1',
      staticName: 'OPD-01',
      serial: 'SN-1',
      device: device as never,
      at: '2026-07-26T00:00:00.000Z',
      actor,
    };

    await listener.handleDeviceChanged(event);

    expect(userAudit.record).toHaveBeenCalledWith({
      entityType: 'device',
      entityId: 'dev-1',
      action: 'updated',
      actor,
      snapshot: device,
    });
  });

  it('handleDeviceChanged ข้ามเมื่อ event ไม่มี actor', async () => {
    const event: DeviceChangedEvent = {
      action: 'online',
      deviceId: 'dev-1',
      staticName: 'OPD-01',
      serial: 'SN-1',
      device: {} as never,
      at: '2026-07-26T00:00:00.000Z',
    };

    await listener.handleDeviceChanged(event);

    expect(userAudit.record).not.toHaveBeenCalled();
  });

  it('handleProbeChanged บันทึก entityType probe', async () => {
    const probe = { id: 'probe-1', deviceId: 'dev-1' };
    const event: ProbeChangedEvent = {
      action: 'created',
      probeId: 'probe-1',
      deviceId: 'dev-1',
      probe: probe as never,
      at: '2026-07-26T00:00:00.000Z',
      actor,
    };

    await listener.handleProbeChanged(event);

    expect(userAudit.record).toHaveBeenCalledWith({
      entityType: 'probe',
      entityId: 'probe-1',
      action: 'created',
      actor,
      snapshot: probe,
    });
  });

  it('handleConfigChanged บันทึก entityType config', async () => {
    const config = { id: 'cfg-1', deviceId: 'dev-1' };
    const event: ConfigChangedEvent = {
      action: 'updated',
      configId: 'cfg-1',
      deviceId: 'dev-1',
      config: config as never,
      at: '2026-07-26T00:00:00.000Z',
      actor,
    };

    await listener.handleConfigChanged(event);

    expect(userAudit.record).toHaveBeenCalledWith({
      entityType: 'config',
      entityId: 'cfg-1',
      action: 'updated',
      actor,
      snapshot: config,
    });
  });

  it('handleRepairChanged บันทึก entityType repair', async () => {
    const repair = { id: 'rep-1', serial: 'SN-1' };
    const event: RepairChangedEvent = {
      action: 'created',
      repairId: 'rep-1',
      serial: 'SN-1',
      repair: repair as never,
      at: '2026-07-26T00:00:00.000Z',
      actor,
    };

    await listener.handleRepairChanged(event);

    expect(userAudit.record).toHaveBeenCalledWith({
      entityType: 'repair',
      entityId: 'rep-1',
      action: 'created',
      actor,
      snapshot: repair,
    });
  });

  it('handleWarrantyChanged บันทึก entityType warranty', async () => {
    const warranty = { id: 'war-1', serial: 'SN-1' };
    const event: WarrantyChangedEvent = {
      action: 'created',
      warrantyId: 'war-1',
      serial: 'SN-1',
      warranty: warranty as never,
      at: '2026-07-26T00:00:00.000Z',
      actor,
    };

    await listener.handleWarrantyChanged(event);

    expect(userAudit.record).toHaveBeenCalledWith({
      entityType: 'warranty',
      entityId: 'war-1',
      action: 'created',
      actor,
      snapshot: warranty,
    });
  });

  it('กลืน error จาก userAudit.record ไม่ให้เด้งกลับไปที่ emitter', async () => {
    userAudit.record.mockRejectedValue(new Error('db down'));
    const event: ProbeChangedEvent = {
      action: 'created',
      probeId: 'probe-1',
      deviceId: 'dev-1',
      probe: {} as never,
      at: '2026-07-26T00:00:00.000Z',
      actor,
    };

    await expect(listener.handleProbeChanged(event)).resolves.toBeUndefined();
  });
});
