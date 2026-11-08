import { NotFoundException } from '@nestjs/common';
import { PartnerService } from './partner.service';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceService } from '../device/device.service';
import { RedisService } from '../redis/redis.service';
import { PartnerApiKeyContext } from './partner-api-key.service';

describe('PartnerService', () => {
  let service: PartnerService;
  let prisma: {
    logDays: { findMany: jest.Mock; findFirst: jest.Mock; count: jest.Mock };
    devices: { findMany: jest.Mock; count: jest.Mock };
    $queryRawUnsafe: jest.Mock;
  };
  let deviceService: { findOne: jest.Mock };

  const apiKey: PartnerApiKeyContext = { id: 'key-1', name: 'Acme', tenants: new Set(['T1']) };

  beforeEach(() => {
    prisma = {
      logDays: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
      devices: { findMany: jest.fn(), count: jest.fn() },
      $queryRawUnsafe: jest.fn(),
    };
    deviceService = { findOne: jest.fn() };
    service = new PartnerService(
      prisma as unknown as PrismaService,
      deviceService as unknown as DeviceService,
      // ไม่ cache ในเทส — เรียก factory ตรง ๆ เหมือน InMemoryRedisStub ฝั่ง e2e
      { getOrSet: (_k: string, _t: number, f: () => unknown) => f() } as unknown as RedisService,
    );
  });

  describe('getDeviceSnapshot', () => {
    it('resolves the device first, then throws NotFoundException if its tenant is not allowed', async () => {
      deviceService.findOne.mockResolvedValue({
        serial: 'SN-1',
        tenantId: 'T2',
        name: 'x',
        status: true,
        online: true,
      });

      await expect(service.getDeviceSnapshot(apiKey, 'SN-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(deviceService.findOne).toHaveBeenCalledWith('SN-1', { kind: 'GLOBAL' });
      expect(prisma.logDays.findMany).not.toHaveBeenCalled();
    });

    it('device that has no tenant yet (not backfilled) is NOT_FOUND for every key', async () => {
      deviceService.findOne.mockResolvedValue({
        serial: 'SN-1',
        tenantId: null,
        name: 'x',
        status: true,
        online: true,
      });

      await expect(service.getDeviceSnapshot(apiKey, 'SN-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns curated metadata + last-1-hour timeseries for an allowed tenant', async () => {
      deviceService.findOne.mockResolvedValue({
        serial: 'SN-1',
        tenantId: 'T1',
        name: 'ตู้เย็น ICU เตียง 3',
        status: true,
        online: true,
        hospital: 'โรงพยาบาล A',
        hardware: { firmware: '2.1.0' },
      });
      prisma.logDays.findMany.mockResolvedValue([
        {
          sendTime: new Date(),
          temp: 4,
          tempDisplay: 4,
          humidity: 50,
          humidityDisplay: 50,
          tempInternal: null,
          battery: 90,
          plug: true,
          door1: false,
          door2: false,
          door3: false,
          internet: true,
          extMemory: false,
          probe: '1',
        },
      ]);

      const result = await service.getDeviceSnapshot(apiKey, 'SN-1');

      expect(result.device).toEqual({
        serial: 'SN-1',
        name: 'ตู้เย็น ICU เตียง 3',
        status: true,
        firmware: '2.1.0',
        online: true,
      });
      expect(result.device).not.toHaveProperty('hospital');
      expect(result.timeseries).toHaveLength(1);

      const [[args]] = prisma.logDays.findMany.mock.calls;
      expect(args.where.serial).toBe('SN-1');
      const windowMs = Date.now() - (args.where.sendTime.gte as Date).getTime();
      expect(windowMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 5000);
      expect(windowMs).toBeLessThanOrEqual(60 * 60 * 1000 + 5000);
    });
  });

  describe('getDeviceHistory', () => {
    it('throws NotFoundException for a tenant outside the allowlist before querying', async () => {
      deviceService.findOne.mockResolvedValue({
        serial: 'SN-1',
        tenantId: 'T2',
        name: 'x',
        status: true,
        online: true,
      });

      await expect(service.getDeviceHistory(apiKey, 'SN-1', 'DAY_7')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it.each([
      ['DAY_1', '15 minutes', 1],
      ['DAY_7', '1 hour', 7],
      ['DAY_30', '3 hours', 30],
    ] as const)(
      '%s uses bucket %s and a %i-day cutoff, mapping rows to the response shape',
      async (range, bucket, days) => {
        deviceService.findOne.mockResolvedValue({
          serial: 'SN-1',
          tenantId: 'T1',
          name: 'F',
          status: true,
          online: true,
          hardware: { firmware: '1.0.0' },
        });
        prisma.$queryRawUnsafe.mockResolvedValue([
          {
            bucket_start: new Date('2026-09-18T00:00:00Z'),
            probe: '1',
            temp_avg: 5,
            temp_min: 4,
            temp_max: 6,
            humidity_avg: 50,
            humidity_min: 45,
            humidity_max: 55,
            battery_min: 90,
            door_open: true,
            samples: 3,
          },
        ]);

        const result = await service.getDeviceHistory(apiKey, 'SN-1', range);

        const [sql, serialArg, cutoff] = prisma.$queryRawUnsafe.mock.calls[0];
        expect(sql).toContain(`time_bucket('${bucket}'`);
        expect(serialArg).toBe('SN-1');
        const cutoffMs = Date.now() - (cutoff as Date).getTime();
        expect(Math.abs(cutoffMs - days * 24 * 60 * 60 * 1000)).toBeLessThan(5000);
        expect(result.bucketInterval).toBe(bucket);
        expect(result.buckets).toEqual([
          {
            bucketStart: '2026-09-18T00:00:00.000Z',
            probe: '1',
            tempAvg: 5,
            tempMin: 4,
            tempMax: 6,
            humidityAvg: 50,
            humidityMin: 45,
            humidityMax: 55,
            batteryMin: 90,
            doorOpen: true,
            samples: 3,
          },
        ]);
      },
    );
  });

  describe('listDeviceTelemetry', () => {
    const row = (sendTime: string) => ({
      sendTime: new Date(sendTime),
      temp: 5,
      tempDisplay: 5,
      humidity: 50,
      humidityDisplay: 50,
      tempInternal: null,
      battery: 90,
      plug: true,
      door1: false,
      door2: false,
      door3: false,
      internet: true,
      extMemory: false,
      probe: '1',
    });

    it('throws NotFoundException for a tenant outside the allowlist before querying', async () => {
      deviceService.findOne.mockResolvedValue({
        serial: 'SN-1',
        tenantId: 'T2',
        name: 'x',
        status: true,
        online: true,
      });

      await expect(service.listDeviceTelemetry(apiKey, 'SN-1', 'DAY_7', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.logDays.findMany).not.toHaveBeenCalled();
    });

    it('paginates newest-first with a stable tiebreaker and a range cutoff', async () => {
      deviceService.findOne.mockResolvedValue({
        serial: 'SN-1',
        tenantId: 'T1',
        name: 'F',
        status: true,
        online: true,
      });
      prisma.logDays.findMany.mockResolvedValue([row('2026-09-18T10:00:00Z')]);
      prisma.logDays.count.mockResolvedValue(120);

      const result = await service.listDeviceTelemetry(apiKey, 'SN-1', 'DAY_7', {
        page: 3,
        limit: 50,
      });

      const [[args]] = prisma.logDays.findMany.mock.calls;
      expect(args.orderBy).toEqual([{ sendTime: 'desc' }, { id: 'desc' }]);
      expect(args.skip).toBe(100);
      expect(args.take).toBe(50);
      const cutoffMs = Date.now() - (args.where.sendTime.gte as Date).getTime();
      expect(Math.abs(cutoffMs - 7 * 24 * 60 * 60 * 1000)).toBeLessThan(5000);
      expect(result).toMatchObject({ total: 120, page: 3, limit: 50 });
      expect(result.points).toHaveLength(1);
    });

    it('applies defaults and caps limit at 200', async () => {
      deviceService.findOne.mockResolvedValue({
        serial: 'SN-1',
        tenantId: 'T1',
        name: 'F',
        status: true,
        online: true,
      });
      prisma.logDays.findMany.mockResolvedValue([]);
      prisma.logDays.count.mockResolvedValue(0);

      expect((await service.listDeviceTelemetry(apiKey, 'SN-1', 'DAY_1', {})).limit).toBe(50);
      expect(
        (await service.listDeviceTelemetry(apiKey, 'SN-1', 'DAY_1', { limit: 9999 })).limit,
      ).toBe(200);
    });
  });

  describe('listDevicesByTenant', () => {
    it('throws NotFoundException for a tenant outside the allowlist', async () => {
      await expect(service.listDevicesByTenant(apiKey, 'T2', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.devices.findMany).not.toHaveBeenCalled();
    });

    it('returns metadata + the single latest reading per device for an allowed tenant', async () => {
      prisma.devices.findMany.mockResolvedValue([
        {
          serial: 'SN-1',
          tenantId: 'T1',
          name: 'Fridge 1',
          status: true,
          online: true,
          hardware: { firmware: '1.0.0' },
        },
      ]);
      prisma.devices.count.mockResolvedValue(1);
      prisma.logDays.findFirst.mockResolvedValue({
        sendTime: new Date('2026-09-15T00:00:00Z'),
        temp: 5,
        tempDisplay: 5,
        humidity: 55,
        humidityDisplay: 55,
        tempInternal: null,
        battery: 88,
        plug: true,
        door1: false,
        door2: false,
        door3: false,
        internet: true,
        extMemory: false,
        probe: '1',
      });

      const result = await service.listDevicesByTenant(apiKey, 'T1', { page: 1, limit: 20 });

      expect(result.total).toBe(1);
      expect(result.devices).toHaveLength(1);
      expect(result.devices[0].device.serial).toBe('SN-1');
      expect(result.devices[0].latest?.temp).toBe(5);
      expect(prisma.devices.findMany.mock.calls[0][0].where).toEqual({ tenantId: 'T1' });
    });

    it('returns latest: null for a device with no telemetry yet', async () => {
      prisma.devices.findMany.mockResolvedValue([
        {
          serial: 'SN-2',
          tenantId: 'T1',
          name: 'Fridge 2',
          status: true,
          online: false,
          hardware: null,
        },
      ]);
      prisma.devices.count.mockResolvedValue(1);
      prisma.logDays.findFirst.mockResolvedValue(null);

      const result = await service.listDevicesByTenant(apiKey, 'T1', {});

      expect(result.devices[0].latest).toBeNull();
    });
  });
});
