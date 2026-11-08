import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { DeviceAssignmentService } from '../device/device-assignment.service';
import { AppEvents } from '../common/events/app-events';
import { LegacyReferenceMissingError, LegacySyncService } from './legacy-sync.service';
import { LegacyDeviceDto, LegacyProbeDto } from './dto/legacy-snapshot.dto';

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-02-01T00:00:00Z');
const T2 = new Date('2026-03-01T00:00:00Z');

const legacyDevice = (over: Partial<LegacyDeviceDto> = {}): LegacyDeviceDto =>
  Object.assign(new LegacyDeviceDto(), {
    id: 'SN-1',
    deviceId: 'L-DEV-1',
    staticName: 'ICU-FRIDGE-3',
    hospital: 'TEN-1',
    ward: 'DEP-1',
    name: 'ICU fridge',
    status: true,
    seq: 1,
    firmware: '2.0.0',
    online: true,
    installDate: T0,
    createAt: T0,
    updateAt: T1,
    ...over,
  });

const legacyProbe = (over: Partial<LegacyProbeDto> = {}): LegacyProbeDto =>
  Object.assign(new LegacyProbeDto(), {
    id: 'L-PROBE-1',
    sn: 'SN-1',
    channel: '1',
    tempMin: 2,
    tempMax: 8,
    humiMin: 0,
    humiMax: 100,
    tempAdj: 0,
    humiAdj: 0,
    doorQty: 1,
    doorSound: true,
    notiDelay: 0,
    notiToNormal: true,
    notiMobile: true,
    notiRepeat: 1,
    firstDay: 'OFF',
    secondDay: 'OFF',
    thirdDay: 'OFF',
    createAt: T0,
    updateAt: T1,
    ...over,
  });

describe('LegacySyncService', () => {
  let service: LegacySyncService;
  let prisma: any;
  let assignments: { assign: jest.Mock; invalidate: jest.Mock };
  let events: { emit: jest.Mock };

  beforeEach(async () => {
    prisma = {
      legacySyncMap: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      hardware: { upsert: jest.fn().mockResolvedValue({}) },
      devices: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
      },
      deviceAssignments: { update: jest.fn(), updateMany: jest.fn() },
      probes: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    assignments = {
      assign: jest.fn().mockResolvedValue({ assignment: { id: 'asg-1' } }),
      invalidate: jest.fn(),
    };
    events = { emit: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        LegacySyncService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: { del: jest.fn(), delByPattern: jest.fn() } },
        { provide: EventEmitter2, useValue: events },
        { provide: DeviceAssignmentService, useValue: assignments },
      ],
    }).compile();
    service = module.get(LegacySyncService);
  });

  const mapRow = (over: object = {}) => ({
    entity: 'device',
    legacyId: 'L-DEV-1',
    targetId: 'dev-1',
    legacyUpdatedAt: T1,
    retired: false,
    ...over,
  });

  describe('last-writer-wins', () => {
    it('ข้าม snapshot ที่ updateAt ไม่ใหม่กว่าที่ apply ไปแล้ว', async () => {
      prisma.legacySyncMap.findUnique.mockResolvedValue(mapRow({ legacyUpdatedAt: T2 }));
      await expect(service.upsertDevice(legacyDevice({ updateAt: T1 }))).resolves.toBe('stale');
      expect(prisma.hardware.upsert).not.toHaveBeenCalled();
    });

    it('ข้ามแถวที่ถูก retire ไปแล้ว (ลบ หรือถูกแทนด้วย Swap)', async () => {
      prisma.legacySyncMap.findUnique.mockResolvedValue(
        mapRow({ retired: true, legacyUpdatedAt: T0 }),
      );
      await expect(service.upsertDevice(legacyDevice({ updateAt: T2 }))).resolves.toBe('retired');
      expect(prisma.devices.update).not.toHaveBeenCalled();
    });
  });

  describe('upsertDevice', () => {
    it('จุดติดตั้งใหม่: สร้าง Devices พร้อม tenantId จาก hospital แล้วติดตั้งกล่องผ่าน assign', async () => {
      prisma.devices.create.mockResolvedValue({
        id: 'dev-new',
        serial: null,
        staticName: 'ICU-FRIDGE-3',
      });

      await expect(service.upsertDevice(legacyDevice())).resolves.toBe('applied');

      const data = prisma.devices.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ tenantId: 'TEN-1', departmentId: 'DEP-1', online: true });
      expect(data.serial).toBeUndefined(); // serial เปลี่ยนผ่าน assign เท่านั้น
      expect(assignments.assign).toHaveBeenCalledWith('dev-new', 'SN-1', 'legacy sync');
      // วันเริ่มติดตั้งจริงมาจากระบบเดิม
      expect(prisma.deviceAssignments.update).toHaveBeenCalledWith({
        where: { id: 'asg-1' },
        data: { startedAt: T0 },
      });
      expect(prisma.legacySyncMap.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            entity: 'device',
            legacyId: 'L-DEV-1',
            targetId: 'dev-new',
          }),
        }),
      );
    });

    it('กล่องเดิม: อัปเดต field แต่ไม่แตะ online และไม่ swap', async () => {
      const existing = { id: 'dev-1', serial: 'SN-1', staticName: 'ICU-FRIDGE-3' };
      prisma.legacySyncMap.findUnique.mockResolvedValue(mapRow({ legacyUpdatedAt: T0 }));
      prisma.devices.findUnique.mockResolvedValue(existing);
      prisma.devices.update.mockResolvedValue(existing);

      await service.upsertDevice(legacyDevice());

      expect(prisma.devices.update.mock.calls[0][0].data.online).toBeUndefined();
      expect(assignments.assign).not.toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith(
        AppEvents.DEVICE_CHANGED,
        expect.objectContaining({ action: 'updated' }),
      );
    });

    it('Swap: แถวใหม่ของระบบเดิมที่ staticName เดิมแต่ serial ใหม่ → assign กล่องใหม่ และ retire แถวเก่า', async () => {
      const point = { id: 'dev-1', serial: 'SN-OLD', staticName: 'ICU-FRIDGE-3' };
      // ไม่มี map ของแถวใหม่ → หาเจอจาก staticName
      prisma.devices.findUnique.mockResolvedValue(point);
      prisma.devices.update.mockResolvedValue(point);

      await service.upsertDevice(legacyDevice({ id: 'SN-NEW', deviceId: 'L-DEV-2' }));

      expect(prisma.legacySyncMap.updateMany).toHaveBeenCalledWith({
        where: {
          entity: 'device',
          targetId: 'dev-1',
          legacyId: { not: 'L-DEV-2' },
          retired: false,
        },
        data: { retired: true },
      });
      expect(assignments.assign).toHaveBeenCalledWith('dev-1', 'SN-NEW', 'legacy sync');
      // จุดติดตั้งเดิม: ไม่เขียนทับวันเริ่มของ assignment ใหม่
      expect(prisma.deviceAssignments.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteDevice', () => {
    it('กล่องยังติดอยู่: ปิด assignment, ล้าง serial, status=false และ retire map', async () => {
      prisma.legacySyncMap.findUnique.mockResolvedValue(mapRow({ legacyUpdatedAt: T0 }));
      prisma.devices.findUnique.mockResolvedValue({ id: 'dev-1', serial: 'SN-1' });
      prisma.devices.update.mockResolvedValue({ id: 'dev-1', serial: null, staticName: 'X' });

      await service.deleteDevice(
        Object.assign(new (class {})(), { id: 'SN-1', deviceId: 'L-DEV-1', updateAt: T2 }) as never,
      );

      expect(prisma.deviceAssignments.updateMany).toHaveBeenCalledWith({
        where: { deviceId: 'dev-1', endedAt: null },
        data: { endedAt: T2 },
      });
      expect(prisma.devices.update).toHaveBeenCalledWith({
        where: { id: 'dev-1' },
        data: { serial: null, status: false },
      });
      expect(prisma.legacySyncMap.upsert.mock.calls[0][0].update.retired).toBe(true);
    });

    it('จุดนั้นถูก Swap เป็นกล่องอื่นแล้ว: ไม่แตะจุดติดตั้ง', async () => {
      prisma.legacySyncMap.findUnique.mockResolvedValue(mapRow({ legacyUpdatedAt: T0 }));
      prisma.devices.findUnique.mockResolvedValue({ id: 'dev-1', serial: 'SN-NEW' });

      await service.deleteDevice({ id: 'SN-OLD', deviceId: 'L-DEV-1', updateAt: T2 } as never);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('upsertProbe', () => {
    it('ผูกกับจุดติดตั้งที่กล่อง sn ติดอยู่ และ claim probe เดิมตาม (deviceId, channel)', async () => {
      prisma.devices.findUnique.mockResolvedValue({ id: 'dev-1', serial: 'SN-1' });
      prisma.probes.findUnique.mockResolvedValue({ id: 'probe-1', deviceId: 'dev-1' });
      prisma.probes.update.mockResolvedValue({ id: 'probe-1', deviceId: 'dev-1' });

      await service.upsertProbe(legacyProbe());

      expect(prisma.probes.findUnique).toHaveBeenCalledWith({
        where: { deviceId_channel: { deviceId: 'dev-1', channel: '1' } },
      });
      expect(events.emit).toHaveBeenCalledWith(
        AppEvents.PROBE_CHANGED,
        expect.objectContaining({ action: 'updated', deviceId: 'dev-1' }),
      );
    });

    it('ยังไม่มีจุดติดตั้งของ serial นี้ → throw ให้เข้า DLQ', async () => {
      prisma.devices.findUnique.mockResolvedValue(null);
      await expect(service.upsertProbe(legacyProbe())).rejects.toBeInstanceOf(
        LegacyReferenceMissingError,
      );
      expect(prisma.legacySyncMap.upsert).not.toHaveBeenCalled();
    });
  });
});
