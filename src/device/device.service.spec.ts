import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DeviceService } from './device.service';
import { DeviceAssignmentService } from './device-assignment.service';
import { DeviceImageStorageService } from './device-image-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AppEvents } from '../common/events/app-events';
import { DeviceChangedEvent } from '../common/events/device-changed.event';

describe('DeviceService — device.changed event', () => {
  let service: DeviceService;
  let prisma: { devices: { findUnique: jest.Mock; update: jest.Mock } };
  let emitter: { emit: jest.Mock };

  const device = {
    id: 'dev-1',
    serial: 'SN-1',
    staticName: 'OPD-01',
    online: true,
  };

  beforeEach(async () => {
    prisma = { devices: { findUnique: jest.fn(), update: jest.fn() } };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: { del: jest.fn(), getOrSet: jest.fn() } },
        { provide: DeviceImageStorageService, useValue: { upload: jest.fn(), delete: jest.fn() } },
        { provide: DeviceAssignmentService, useValue: { invalidate: jest.fn() } },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get(DeviceService);
  });

  it('setOnline emit device.changed พร้อม device ทั้งก้อน เมื่อสถานะเปลี่ยนจริง', async () => {
    prisma.devices.findUnique.mockResolvedValue({ online: false });
    prisma.devices.update.mockResolvedValue(device);

    await service.setOnline('SN-1', true);

    expect(emitter.emit).toHaveBeenCalledTimes(1);
    const [name, payload] = emitter.emit.mock.calls[0] as [string, DeviceChangedEvent];
    expect(name).toBe(AppEvents.DEVICE_CHANGED);
    expect(payload.action).toBe('online');
    expect(payload.serial).toBe('SN-1');
    expect(payload.staticName).toBe('OPD-01');
    expect(payload.device).toBe(device);
  });

  it('setOnline ใช้ action offline เมื่อเครื่องหลุด', async () => {
    prisma.devices.findUnique.mockResolvedValue({ online: true });
    prisma.devices.update.mockResolvedValue({ ...device, online: false });

    await service.setOnline('SN-1', false);

    expect((emitter.emit.mock.calls[0][1] as DeviceChangedEvent).action).toBe('offline');
  });

  it('setOnline ไม่ emit ซ้ำเมื่อ heartbeat ส่งสถานะเดิมมา', async () => {
    prisma.devices.findUnique.mockResolvedValue({ online: true });
    prisma.devices.update.mockResolvedValue(device);

    const result = await service.setOnline('SN-1', true);

    // ยังเขียน DB ตามปกติ แค่ไม่กวน client ที่เปิด stream ค้างอยู่
    expect(prisma.devices.update).toHaveBeenCalledTimes(1);
    expect(emitter.emit).not.toHaveBeenCalled();
    expect(result).toBe(device);
  });

  it('listener ที่โยน error ต้องไม่ทำให้ mutation ที่ commit แล้วพัง', async () => {
    prisma.devices.findUnique.mockResolvedValue({ online: false });
    prisma.devices.update.mockResolvedValue(device);
    emitter.emit.mockImplementation(() => {
      throw new Error('listener พัง');
    });

    await expect(service.setOnline('SN-1', true)).resolves.toBe(device);
  });
});
