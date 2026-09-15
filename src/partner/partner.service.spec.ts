import { NotFoundException } from '@nestjs/common';
import { PartnerService } from './partner.service';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceService } from '../device/device.service';
import { PartnerApiKeyContext } from './partner-api-key.service';

describe('PartnerService', () => {
  let service: PartnerService;
  let prisma: {
    logDays: { findMany: jest.Mock; findFirst: jest.Mock };
    devices: { findMany: jest.Mock; count: jest.Mock };
  };
  let deviceService: { findOne: jest.Mock };

  const apiKey: PartnerApiKeyContext = { id: 'key-1', name: 'Acme', wards: new Set(['ICU']) };

  beforeEach(() => {
    prisma = {
      logDays: { findMany: jest.fn(), findFirst: jest.fn() },
      devices: { findMany: jest.fn(), count: jest.fn() },
    };
    deviceService = { findOne: jest.fn() };
    service = new PartnerService(
      prisma as unknown as PrismaService,
      deviceService as unknown as DeviceService,
    );
  });

  describe('getDeviceSnapshot', () => {
    it('resolves the device first, then throws NotFoundException if its ward is not allowed', async () => {
      deviceService.findOne.mockResolvedValue({
        serial: 'SN-1',
        ward: 'OPD',
        name: 'x',
        status: true,
        online: true,
      });

      await expect(service.getDeviceSnapshot(apiKey, 'SN-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(deviceService.findOne).toHaveBeenCalledWith('SN-1');
      expect(prisma.logDays.findMany).not.toHaveBeenCalled();
    });

    it('returns curated metadata + last-1-hour timeseries for an allowed ward', async () => {
      deviceService.findOne.mockResolvedValue({
        serial: 'SN-1',
        ward: 'ICU',
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

  describe('listDevicesByWard', () => {
    it('throws NotFoundException for a ward outside the allowlist', async () => {
      await expect(service.listDevicesByWard(apiKey, 'OPD', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.devices.findMany).not.toHaveBeenCalled();
    });

    it('returns metadata + the single latest reading per device for an allowed ward', async () => {
      prisma.devices.findMany.mockResolvedValue([
        {
          serial: 'SN-1',
          ward: 'ICU',
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

      const result = await service.listDevicesByWard(apiKey, 'ICU', { page: 1, limit: 20 });

      expect(result.total).toBe(1);
      expect(result.devices).toHaveLength(1);
      expect(result.devices[0].device.serial).toBe('SN-1');
      expect(result.devices[0].latest?.temp).toBe(5);
      expect(prisma.devices.findMany.mock.calls[0][0].where).toEqual({ ward: 'ICU' });
    });

    it('returns latest: null for a device with no telemetry yet', async () => {
      prisma.devices.findMany.mockResolvedValue([
        {
          serial: 'SN-2',
          ward: 'ICU',
          name: 'Fridge 2',
          status: true,
          online: false,
          hardware: null,
        },
      ]);
      prisma.devices.count.mockResolvedValue(1);
      prisma.logDays.findFirst.mockResolvedValue(null);

      const result = await service.listDevicesByWard(apiKey, 'ICU', {});

      expect(result.devices[0].latest).toBeNull();
    });
  });
});
