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

describe('TelemetryService', () => {
  let service: TelemetryService;
  let prisma: { logDays: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock } };
  let emitter: { emit: jest.Mock };
  let metrics: jest.Mocked<MetricsService>;
  let assignments: { resolveDeviceId: jest.Mock };
  let probes: { resolveProbeId: jest.Mock };

  beforeEach(async () => {
    prisma = { logDays: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() } };
    emitter = { emit: jest.fn() };
    metrics = createMetricsMock();
    // ค่า default: กล่องนี้ติดตั้งอยู่ที่จุดติดตั้ง dev-1
    assignments = { resolveDeviceId: jest.fn().mockResolvedValue('dev-1') };
    probes = { resolveProbeId: jest.fn().mockResolvedValue('probe-1') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelemetryService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: emitter },
        { provide: DeviceAssignmentService, useValue: assignments },
        { provide: ProbeResolverService, useValue: probes },
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

  it('แปลง sendTime string เป็น Date', async () => {
    prisma.logDays.create.mockResolvedValue({ id: 'x', serial: 'SN-1', sendTime: new Date() });
    await service.ingest({ serial: 'SN-1', sendTime: '2026-07-15T10:00:00Z' });
    const arg = prisma.logDays.create.mock.calls[0][0];
    expect(arg.data.sendTime).toBeInstanceOf(Date);
  });

  it('find ประกอบ where จาก serial + ช่วงเวลา และจำกัด limit', async () => {
    prisma.logDays.findMany.mockResolvedValue([]);
    prisma.logDays.count.mockResolvedValue(0);
    await service.find({
      serial: 'SN-1',
      from: '2026-07-01T00:00:00Z',
      to: '2026-07-15T00:00:00Z',
      limit: 50,
    });

    const arg = prisma.logDays.findMany.mock.calls[0][0];
    expect(arg.where.serial).toBe('SN-1');
    expect(arg.where.sendTime.gte).toBeInstanceOf(Date);
    expect(arg.where.sendTime.lte).toBeInstanceOf(Date);
    expect(arg.take).toBe(50);
  });

  it('find ใช้ default limit 100 เมื่อไม่ระบุ', async () => {
    prisma.logDays.findMany.mockResolvedValue([]);
    prisma.logDays.count.mockResolvedValue(0);
    await service.find({});
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

    await service.find({ deviceId: 'dev-1', probeId: 'probe-2', probe: '2' });

    const { where } = prisma.logDays.findMany.mock.calls[0][0];
    expect(where.probeId).toBe('probe-2');
    expect(where.probe).toBe('2');
  });

  it('บันทึกเวลาที่ใช้ ingest เป็น metric', async () => {
    prisma.logDays.create.mockResolvedValue({ id: 'x', serial: 'SN-1', sendTime: new Date() });
    await service.ingest({ serial: 'SN-1', temp: 4 });

    expect(metrics.recordIngestDuration).toHaveBeenCalledWith(expect.any(Number), 'SN-1');
  });
});
