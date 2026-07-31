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
  let prisma: {
    devices: { findUnique: jest.Mock; update: jest.Mock; create: jest.Mock };
    hardware: { upsert: jest.Mock; update: jest.Mock };
    deviceAssignments: { create: jest.Mock };
    configs: { create: jest.Mock };
    probes: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let emitter: { emit: jest.Mock };

  const device = {
    id: 'dev-1',
    serial: 'SN-1',
    staticName: 'OPD-01',
    online: true,
  };

  const config = { id: 'cfg-1', deviceId: 'dev-1' };
  const probe = { id: 'probe-1', deviceId: 'dev-1', name: 'P1' };

  const actor = { id: 'user-1', name: 'Somchai', role: 'ADMIN' };

  beforeEach(async () => {
    prisma = {
      devices: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
      hardware: { upsert: jest.fn(), update: jest.fn() },
      deviceAssignments: { create: jest.fn() },
      configs: { create: jest.fn() },
      probes: { create: jest.fn() },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
    };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RedisService,
          useValue: { del: jest.fn(), delByPattern: jest.fn(), getOrSet: jest.fn() },
        },
        { provide: DeviceImageStorageService, useValue: { upload: jest.fn(), delete: jest.fn() } },
        { provide: DeviceAssignmentService, useValue: { invalidate: jest.fn() } },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get(DeviceService);
  });

  it('create ส่ง actor เข้า event device.changed ให้ audit ตามได้ว่าใครสร้าง', async () => {
    prisma.devices.create.mockResolvedValue(device);
    prisma.configs.create.mockResolvedValue(config);
    prisma.probes.create.mockResolvedValue(probe);

    await service.create({ staticName: 'OPD-01' } as never, undefined, actor);

    const [name, payload] = emitter.emit.mock.calls[0] as [string, DeviceChangedEvent];
    expect(name).toBe(AppEvents.DEVICE_CHANGED);
    expect(payload.action).toBe('created');
    expect(payload.actor).toEqual(actor);
  });

  it('create ไม่แนบ actor เมื่อไม่มีการส่งมา (ไม่ควรเกิดขึ้นจริงเพราะ route guard แล้ว)', async () => {
    prisma.devices.create.mockResolvedValue(device);
    prisma.configs.create.mockResolvedValue(config);
    prisma.probes.create.mockResolvedValue(probe);

    await service.create({ staticName: 'OPD-01' } as never);

    const [, payload] = emitter.emit.mock.calls[0] as [string, DeviceChangedEvent];
    expect(payload.actor).toBeUndefined();
  });

  it('create สร้าง Configs และ Probes default พ่วงไปกับ device ในทรานแซกชันเดียวกัน', async () => {
    prisma.devices.create.mockResolvedValue(device);
    prisma.configs.create.mockResolvedValue(config);
    prisma.probes.create.mockResolvedValue(probe);

    await service.create({ staticName: 'OPD-01' } as never, undefined, actor);

    expect(prisma.configs.create).toHaveBeenCalledWith({ data: { deviceId: device.id } });
    expect(prisma.probes.create).toHaveBeenCalledWith({ data: { deviceId: device.id } });

    const configEvent = emitter.emit.mock.calls.find(([n]) => n === AppEvents.CONFIG_CHANGED);
    const probeEvent = emitter.emit.mock.calls.find(([n]) => n === AppEvents.PROBE_CHANGED);
    expect(configEvent?.[1]).toMatchObject({ action: 'created', config, actor });
    expect(probeEvent?.[1]).toMatchObject({ action: 'created', probe, actor });
  });

  it('update ส่ง actor เข้า event device.changed ให้ audit ตามได้ว่าใครแก้ไข', async () => {
    prisma.devices.update.mockResolvedValue(device);

    await service.update('SN-1', {} as never, undefined, actor);

    const [name, payload] = emitter.emit.mock.calls[0] as [string, DeviceChangedEvent];
    expect(name).toBe(AppEvents.DEVICE_CHANGED);
    expect(payload.action).toBe('updated');
    expect(payload.actor).toEqual(actor);
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

describe('DeviceService — findAll pagination', () => {
  let service: DeviceService;
  let prisma: { devices: { findMany: jest.Mock; count: jest.Mock } };
  let redis: { getOrSet: jest.Mock };

  beforeEach(async () => {
    prisma = { devices: { findMany: jest.fn(), count: jest.fn() } };
    redis = {
      getOrSet: jest.fn((_key: string, _ttl: number, factory: () => unknown) => factory()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: DeviceImageStorageService, useValue: {} },
        { provide: DeviceAssignmentService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(DeviceService);
  });

  it('ไม่มี ward filter → count ทั้งตาราง ไม่ผ่าน where', async () => {
    prisma.devices.findMany.mockResolvedValue([]);
    prisma.devices.count.mockResolvedValue(50);

    const result = await service.findAll({ page: 1, limit: 20 } as never);

    expect(prisma.devices.count).toHaveBeenCalledWith({ where: undefined });
    expect(result.meta.total).toBe(50);
    expect(result.meta.totalPages).toBe(3);
  });

  it('มี ward filter → findMany และ count ต้องใช้ where เดียวกัน ไม่ใช่ count เต็มตาราง', async () => {
    prisma.devices.findMany.mockResolvedValue([]);
    // ตั้งใจให้ค่านี้เล็กกว่าที่ควรจะเป็นถ้า count ไม่กรอง ward (เช่น 50 ทั้งตาราง)
    // เพื่อพิสูจน์ว่า meta.total มาจาก count ที่กรองแล้วจริง ๆ ไม่ใช่ค่าที่ hardcode ไว้ทั้งระบบ
    prisma.devices.count.mockResolvedValue(3);

    const result = await service.findAll({ page: 1, limit: 20, ward: ['ICU'] } as never);

    const expectedWhere = { where: { ward: { in: ['ICU'] } } };
    expect(prisma.devices.findMany).toHaveBeenCalledWith(expect.objectContaining(expectedWhere));
    expect(prisma.devices.count).toHaveBeenCalledWith(expectedWhere);
    expect(result.meta.total).toBe(3);
    expect(result.meta.totalPages).toBe(1);
  });
});
