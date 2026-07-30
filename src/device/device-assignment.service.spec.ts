import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DeviceAssignmentService } from './device-assignment.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AppEvents } from '../common/events/app-events';
import { DeviceChangedEvent } from '../common/events/device-changed.event';

describe('DeviceAssignmentService — device.changed event', () => {
  let service: DeviceAssignmentService;
  let prisma: {
    devices: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    hardware: { upsert: jest.Mock };
    deviceAssignments: { updateMany: jest.Mock; create: jest.Mock; findFirstOrThrow: jest.Mock };
    $transaction: jest.Mock;
  };
  let emitter: { emit: jest.Mock };

  const actor = { id: 'user-1', name: 'Somchai', role: 'SUPER' };

  beforeEach(async () => {
    prisma = {
      devices: {
        findUnique: jest.fn().mockResolvedValue({ id: 'dev-1', serial: 'SN-OLD' }),
        update: jest
          .fn()
          .mockResolvedValue({ id: 'dev-1', serial: 'SN-NEW', staticName: 'OPD-01' }),
        updateMany: jest.fn(),
      },
      hardware: { upsert: jest.fn() },
      deviceAssignments: {
        updateMany: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'assign-1' }),
        findFirstOrThrow: jest.fn(),
      },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
    };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceAssignmentService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: { del: jest.fn() } },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get(DeviceAssignmentService);
  });

  it('assign ส่ง actor เข้า event device.changed action swapped', async () => {
    await service.assign('dev-1', 'SN-NEW', 'สลับเครื่องพัง', actor);

    expect(emitter.emit).toHaveBeenCalledTimes(1);
    const [name, payload] = emitter.emit.mock.calls[0] as [string, DeviceChangedEvent];
    expect(name).toBe(AppEvents.DEVICE_CHANGED);
    expect(payload.action).toBe('swapped');
    expect(payload.actor).toEqual(actor);
    expect(payload.previousSerial).toBe('SN-OLD');
  });

  it('ไม่ emit เมื่อสลับด้วย serial เดิม (no-op)', async () => {
    prisma.devices.findUnique.mockResolvedValue({ id: 'dev-1', serial: 'SN-NEW' });
    prisma.deviceAssignments.findFirstOrThrow.mockResolvedValue({ id: 'assign-1' });

    await service.assign('dev-1', 'SN-NEW', undefined, actor);

    expect(emitter.emit).not.toHaveBeenCalled();
  });
});
