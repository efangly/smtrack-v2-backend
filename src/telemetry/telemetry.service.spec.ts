import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TelemetryService } from './telemetry.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppEvents } from '../common/events/app-events';
import { CreateTelemetryDto } from './dto/create-telemetry.dto';
import { MetricsService } from '../observability/metrics.service';
import { createMetricsMock, observabilityTestProviders } from '../observability/testing';
import { DeviceAssignmentService } from '../device/device-assignment.service';
import { ProbeResolverService } from '../probe/probe-resolver.service';
import { AccessScope } from '../common/auth/access-scope';
import { RestoredWindowService } from '../backup/restored-window.service';
import { Prisma } from '../generated/prisma/client';

const GLOBAL: AccessScope = { kind: 'GLOBAL' };

describe('TelemetryService', () => {
  let service: TelemetryService;
  let prisma: {
    logDays: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findFirstOrThrow: jest.Mock;
    };
    logDayArchive: { findMany: jest.Mock; count: jest.Mock };
    devices: { count: jest.Mock };
  };
  let restored: { ensureRange: jest.Mock };
  let emitter: { emit: jest.Mock };
  let metrics: jest.Mocked<MetricsService>;
  let assignments: { resolveDeviceId: jest.Mock; resolveDeviceIdOrThrow: jest.Mock };
  let probes: { resolveProbeId: jest.Mock };

  beforeEach(async () => {
    prisma = {
      logDays: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        findFirstOrThrow: jest.fn(),
      },
      logDayArchive: { findMany: jest.fn(), count: jest.fn() },
      devices: { count: jest.fn().mockResolvedValue(1) },
    };
    restored = { ensureRange: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };
    metrics = createMetricsMock();
    // ค่า default: กล่องนี้ติดตั้งอยู่ที่จุดติดตั้ง dev-1
    assignments = {
      resolveDeviceId: jest.fn().mockResolvedValue('dev-1'),
      resolveDeviceIdOrThrow: jest.fn().mockResolvedValue('dev-1'),
    };
    probes = { resolveProbeId: jest.fn().mockResolvedValue('probe-1') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelemetryService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: emitter },
        { provide: DeviceAssignmentService, useValue: assignments },
        { provide: ProbeResolverService, useValue: probes },
        { provide: RestoredWindowService, useValue: restored },
        ...observabilityTestProviders(metrics),
      ],
    }).compile();

    service = module.get(TelemetryService);
  });

  it('บันทึก log แล้ว emit TELEMETRY_CREATED', async () => {
    const dto: CreateTelemetryDto = { serial: 'SN-1', temp: 5.5 };
    const stored = { id: 'log-1', serial: 'SN-1', sendTime: new Date('2026-07-15T00:00:00Z') };
    prisma.logDays.create.mockResolvedValue(stored);

    const result = await service.ingest(dto);

    expect(prisma.logDays.create).toHaveBeenCalledTimes(1);
    const arg = prisma.logDays.create.mock.calls[0][0];
    expect(arg.data.hardware).toEqual({ connect: { serial: 'SN-1' } });
    // ประทับจุดติดตั้งที่ resolve ได้ ณ เวลา ingest
    expect(arg.data.device).toEqual({ connect: { id: 'dev-1' } });
    expect(arg.data.temp).toBe(5.5);
    expect(emitter.emit).toHaveBeenCalledWith(AppEvents.TELEMETRY_CREATED, stored);
    expect(result).toBe(stored);
  });

  describe('log ซ้ำ (serial, probe, sendTime)', () => {
    const dup = () =>
      new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
        code: 'P2002',
        clientVersion: 'x',
      });

    it('คืนแถวเดิมและไม่ emit TELEMETRY_CREATED ซ้ำ', async () => {
      const existing = {
        id: 'log-old',
        serial: 'SN-1',
        sendTime: new Date('2026-07-15T10:00:00Z'),
      };
      prisma.logDays.create.mockRejectedValue(dup());
      prisma.logDays.findFirstOrThrow.mockResolvedValue(existing);

      const result = await service.ingest({
        serial: 'SN-1',
        probe: '2',
        sendTime: '2026-07-15T10:00:00Z',
      });

      expect(result).toBe(existing);
      expect(prisma.logDays.findFirstOrThrow).toHaveBeenCalledWith({
        where: { serial: 'SN-1', probe: '2', sendTime: new Date('2026-07-15T10:00:00Z') },
      });
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('error อื่นยัง throw ตามเดิม', async () => {
      prisma.logDays.create.mockRejectedValue(new Error('db down'));
      await expect(
        service.ingest({ serial: 'SN-1', sendTime: '2026-07-15T10:00:00Z' }),
      ).rejects.toThrow('db down');
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  it('แปลง sendTime string เป็น Date', async () => {
    prisma.logDays.create.mockResolvedValue({ id: 'x', serial: 'SN-1', sendTime: new Date() });
    await service.ingest({ serial: 'SN-1', sendTime: '2026-07-15T10:00:00Z' });
    const arg = prisma.logDays.create.mock.calls[0][0];
    expect(arg.data.sendTime).toBeInstanceOf(Date);
  });

  it('find ประกอบ where จาก serial + ช่วงเวลา และจำกัด limit', async () => {
    prisma.logDays.findMany.mockResolvedValue([]);
    prisma.logDays.count.mockResolvedValue(0);
    await service.find(
      {
        serial: 'SN-1',
        from: '2026-07-01T00:00:00Z',
        to: '2026-07-15T00:00:00Z',
        limit: 50,
      },
      GLOBAL,
    );

    const arg = prisma.logDays.findMany.mock.calls[0][0];
    expect(arg.where.serial).toBe('SN-1');
    expect(arg.where.sendTime.gte).toBeInstanceOf(Date);
    expect(arg.where.sendTime.lte).toBeInstanceOf(Date);
    expect(arg.take).toBe(50);
  });

  it('find ใช้ default limit 100 เมื่อไม่ระบุ', async () => {
    prisma.logDays.findMany.mockResolvedValue([]);
    prisma.logDays.count.mockResolvedValue(0);
    await service.find({}, GLOBAL);
    expect(prisma.logDays.findMany.mock.calls[0][0].take).toBe(100);
  });

  it('ปฏิเสธเมื่อไม่มี serial ทั้งใน payload และ topic', async () => {
    await expect(service.ingest({ temp: 4 })).rejects.toThrow(/serial is required/);
    expect(prisma.logDays.create).not.toHaveBeenCalled();
  });

  it('ปฏิเสธเมื่อ serial เป็นช่องว่างล้วน', async () => {
    await expect(service.ingest({ serial: '   ', temp: 4 })).rejects.toThrow(/serial is required/);
    expect(prisma.logDays.create).not.toHaveBeenCalled();
  });

  describe('ผูก probe', () => {
    beforeEach(() =>
      prisma.logDays.create.mockResolvedValue({
        id: 'x',
        serial: 'SN-1',
        sendTime: new Date(),
      }),
    );

    const createArg = () => prisma.logDays.create.mock.calls[0][0].data;

    it('resolve probeId จาก channel ที่ส่งมา แล้ว connect เข้า log', async () => {
      await service.ingest({ serial: 'SN-1', probe: '2', temp: 4 });

      expect(probes.resolveProbeId).toHaveBeenCalledWith('dev-1', '2');
      expect(createArg().probeRef).toEqual({ connect: { id: 'probe-1' } });
      expect(createArg().probe).toBe('2');
    });

    it('ไม่ส่ง probe มา → default channel เป็น "1"', async () => {
      await service.ingest({ serial: 'SN-1', temp: 4 });

      expect(probes.resolveProbeId).toHaveBeenCalledWith('dev-1', '1');
      expect(createArg().probe).toBe('1');
    });

    it('probe เป็นช่องว่างล้วน → ถือว่าไม่ได้ส่งมา ใช้ "1"', async () => {
      await service.ingest({ serial: 'SN-1', probe: '  ', temp: 4 });

      expect(probes.resolveProbeId).toHaveBeenCalledWith('dev-1', '1');
      expect(createArg().probe).toBe('1');
    });

    it('กล่องที่ยังไม่ถูกติดตั้ง → ไม่ผูก probe แต่ยังเก็บ channel ดิบไว้', async () => {
      assignments.resolveDeviceId.mockResolvedValue(null);

      await service.ingest({ serial: 'SN-1', probe: '3', temp: 4 });

      expect(probes.resolveProbeId).not.toHaveBeenCalled();
      expect(createArg().probeRef).toBeUndefined();
      expect(createArg().device).toBeUndefined();
      expect(createArg().probe).toBe('3');
    });
  });

  it('find กรองด้วย probeId และ channel ได้', async () => {
    prisma.logDays.findMany.mockResolvedValue([]);
    prisma.logDays.count.mockResolvedValue(0);

    await service.find({ deviceId: 'dev-1', probeId: 'probe-2', probe: '2' }, GLOBAL);

    const { where } = prisma.logDays.findMany.mock.calls[0][0];
    expect(where.probeId).toBe('probe-2');
    expect(where.probe).toBe('2');
  });

  it('find กรองด้วย serialOrName โดย resolve เป็น deviceId ผ่าน DeviceAssignmentService', async () => {
    prisma.logDays.findMany.mockResolvedValue([]);
    prisma.logDays.count.mockResolvedValue(0);
    assignments.resolveDeviceIdOrThrow.mockResolvedValue('dev-2');

    await service.find({ serialOrName: 'DEVICE-STATIC-NAME' }, GLOBAL);

    expect(assignments.resolveDeviceIdOrThrow).toHaveBeenCalledWith('DEVICE-STATIC-NAME', GLOBAL);
    expect(prisma.logDays.findMany.mock.calls[0][0].where.deviceId).toBe('dev-2');
  });

  it('find ของผู้ใช้ที่ถูก scope กรอง log ตามจุดติดตั้งที่ประทับไว้ (tenant/department)', async () => {
    prisma.logDays.findMany.mockResolvedValue([]);
    prisma.logDays.count.mockResolvedValue(0);
    const scope: AccessScope = { kind: 'TENANT', tenantId: 'T1', departments: ['OPD'] };

    await service.find({ serial: 'SN-1' }, scope);

    const { where } = prisma.logDays.findMany.mock.calls[0][0];
    expect(where).toEqual({
      serial: 'SN-1',
      device: { tenantId: 'T1', departmentId: { in: ['OPD'] } },
    });
    expect(prisma.logDays.count.mock.calls[0][0].where).toEqual(where);
  });

  describe('find ข้อมูลนอก hot window (on-demand restore)', () => {
    const OLD = { deviceId: 'dev-1', from: '2020-01-01T00:00:00Z', to: '2020-01-31T00:00:00Z' };
    const row = (id: string) => ({ id });

    it('ระบุ deviceId + ช่วงเวลาเก่า: restore ก่อน แล้วอ่าน archive ต่อท้ายผลของ log_days', async () => {
      prisma.logDays.count.mockResolvedValue(2);
      prisma.logDayArchive.count.mockResolvedValue(3);
      prisma.logDays.findMany.mockResolvedValue([row('h1'), row('h2')]);
      prisma.logDayArchive.findMany.mockResolvedValue([row('a1'), row('a2'), row('a3')]);

      const res = await service.find({ ...OLD, limit: 10 }, GLOBAL);

      expect(restored.ensureRange).toHaveBeenCalledWith(
        'dev-1',
        new Date(OLD.from),
        new Date(OLD.to),
      );
      expect(res.data.map((r) => r.id)).toEqual(['h1', 'h2', 'a1', 'a2', 'a3']);
      expect(res.meta.total).toBe(5);
      expect(prisma.logDayArchive.findMany.mock.calls[0][0]).toMatchObject({
        where: { deviceId: 'dev-1' },
        skip: 0,
        take: 8,
      });
    });

    it('แบ่งหน้าข้ามรอยต่อ: หน้าที่เลย log_days แล้วอ่านเฉพาะ archive ด้วย skip ที่ถูกต้อง', async () => {
      prisma.logDays.count.mockResolvedValue(2);
      prisma.logDayArchive.count.mockResolvedValue(10);
      prisma.logDayArchive.findMany.mockResolvedValue([row('a5')]);

      await service.find({ ...OLD, limit: 4, page: 2 }, GLOBAL);

      // skip รวม = 4, log_days มี 2 แถว → archive ต้องข้าม 2 แถวแรก
      expect(prisma.logDays.findMany).not.toHaveBeenCalled();
      expect(prisma.logDayArchive.findMany.mock.calls[0][0]).toMatchObject({ skip: 2, take: 4 });
    });

    it('ไม่ระบุ limit: ใช้ default 100 ทั้ง skip และ take (หน้า 2 ไม่ซ้อนกับหน้า 1)', async () => {
      prisma.logDays.count.mockResolvedValue(250);
      prisma.logDays.findMany.mockResolvedValue([]);

      await service.find({ page: 2 }, GLOBAL);

      expect(prisma.logDays.findMany.mock.calls[0][0]).toMatchObject({ skip: 100, take: 100 });
    });

    it('ผู้ใช้ที่ scope ไม่เห็นจุดติดตั้งนั้น: ไม่ restore และไม่อ่าน archive', async () => {
      prisma.logDays.count.mockResolvedValue(0);
      prisma.logDays.findMany.mockResolvedValue([]);
      prisma.devices.count.mockResolvedValue(0);
      const scope: AccessScope = { kind: 'TENANT', tenantId: 'T1', departments: ['OPD'] };

      await service.find(OLD, scope);

      expect(prisma.devices.count).toHaveBeenCalledWith({
        where: { id: 'dev-1', tenantId: 'T1', departmentId: { in: ['OPD'] } },
      });
      expect(restored.ensureRange).not.toHaveBeenCalled();
      expect(prisma.logDayArchive.findMany).not.toHaveBeenCalled();
    });

    it('ค้นด้วย serial อย่างเดียว (ไม่มี deviceId): ไม่อ่าน archive', async () => {
      prisma.logDays.count.mockResolvedValue(0);
      prisma.logDays.findMany.mockResolvedValue([]);

      await service.find({ serial: 'SN-1', from: OLD.from, to: OLD.to }, GLOBAL);

      expect(restored.ensureRange).not.toHaveBeenCalled();
    });

    it('to อยู่นอก hot window แต่ไม่มี from: 400', async () => {
      await expect(service.find({ deviceId: 'dev-1', to: OLD.to }, GLOBAL)).rejects.toThrow(
        /ต้องระบุ from/,
      );
      expect(prisma.logDays.findMany).not.toHaveBeenCalled();
    });
  });

  it('find ปฏิเสธเมื่อส่ง serialOrName พร้อมกับ serial หรือ deviceId', async () => {
    await expect(service.find({ serialOrName: 'x', serial: 'SN-1' }, GLOBAL)).rejects.toThrow(
      /ระบุ serial, deviceId หรือ serialOrName ได้เพียงอย่างเดียว/,
    );
    await expect(service.find({ serialOrName: 'x', deviceId: 'dev-1' }, GLOBAL)).rejects.toThrow(
      /ระบุ serial, deviceId หรือ serialOrName ได้เพียงอย่างเดียว/,
    );
    expect(prisma.logDays.findMany).not.toHaveBeenCalled();
  });

  it('บันทึกเวลาที่ใช้ ingest เป็น metric', async () => {
    prisma.logDays.create.mockResolvedValue({ id: 'x', serial: 'SN-1', sendTime: new Date() });
    await service.ingest({ serial: 'SN-1', temp: 4 });

    expect(metrics.recordIngestDuration).toHaveBeenCalledWith(expect.any(Number), 'SN-1');
  });
});
