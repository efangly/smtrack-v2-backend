import { Test, TestingModule } from '@nestjs/testing';
import { AuditListener } from './audit.listener';
import { AuditService } from './audit.service';
import { DeviceChangedEvent } from '../common/events/device-changed.event';

describe('AuditListener', () => {
  let listener: AuditListener;
  let audit: { record: jest.Mock };

  const actor = { id: 'user-1', name: 'Somchai', role: 'ADMIN' };
  const device = { id: 'dev-1', staticName: 'OPD-01', serial: 'SN-1' };

  const baseEvent: DeviceChangedEvent = {
    action: 'updated',
    deviceId: 'dev-1',
    staticName: 'OPD-01',
    serial: 'SN-1',
    device: device as never,
    at: '2026-07-26T00:00:00.000Z',
  };

  beforeEach(async () => {
    audit = { record: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AuditListener, { provide: AuditService, useValue: audit }],
    }).compile();

    listener = module.get(AuditListener);
  });

  it('บันทึก audit เมื่อ event มี actor', async () => {
    await listener.handleDeviceChanged({ ...baseEvent, actor });

    expect(audit.record).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      staticName: 'OPD-01',
      action: 'updated',
      actor,
      snapshot: device,
    });
  });

  it('ข้ามการบันทึกเมื่อ event ไม่มี actor (เช่น online/offline heartbeat)', async () => {
    await listener.handleDeviceChanged({ ...baseEvent, action: 'online' });

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('กลืน error จาก audit.record ไม่ให้เด้งกลับไปที่ emitter', async () => {
    audit.record.mockRejectedValue(new Error('db down'));

    await expect(listener.handleDeviceChanged({ ...baseEvent, actor })).resolves.toBeUndefined();
  });
});
