import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { ProbeService } from './probe.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppEvents } from '../common/events/app-events';

describe('ProbeService', () => {
  let service: ProbeService;
  let prisma: {
    probes: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    logDays: {
      findMany: jest.Mock;
    };
  };
  let events: { emit: jest.Mock };

  const actor = { id: 'user-1', name: 'Somchai', role: 'ADMIN' };
  const probe = { id: 'probe-1', deviceId: 'dev-1', name: 'P1' };

  beforeEach(async () => {
    prisma = {
      probes: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      logDays: {
        findMany: jest.fn(),
      },
    };
    events = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProbeService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();

    service = module.get(ProbeService);
  });

  it('create สร้าง probe ผูกกับ deviceId จาก param แล้ว emit probe.changed (created)', async () => {
    prisma.probes.create.mockResolvedValue(probe);
    prisma.probes.findMany.mockResolvedValue([{ channel: '1' }]);

    const result = await service.create('dev-1', { name: 'P1' }, actor);

    expect(prisma.probes.create).toHaveBeenCalledWith({
      data: { name: 'P1', channel: '2', deviceId: 'dev-1' },
    });
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.PROBE_CHANGED,
      expect.objectContaining({ action: 'created', probeId: 'probe-1', deviceId: 'dev-1', actor }),
    );
    expect(result).toEqual(probe);
  });

  describe('create: default channel', () => {
    beforeEach(() => prisma.probes.create.mockResolvedValue(probe));

    const createdChannel = () => prisma.probes.create.mock.calls[0][0].data.channel;

    it('channel ที่ส่งมาใน dto ชนะการเดาเสมอ', async () => {
      prisma.probes.findMany.mockResolvedValue([{ channel: '1' }, { channel: '2' }]);

      await service.create('dev-1', { channel: '7' });

      expect(createdChannel()).toBe('7');
      // ไม่ต้องไปนับช่องเลยเมื่อผู้ใช้ระบุมาแล้ว
      expect(prisma.probes.findMany).not.toHaveBeenCalled();
    });

    it('ไม่ส่ง channel → ได้ช่องถัดไปจากเลขที่มากสุด', async () => {
      prisma.probes.findMany.mockResolvedValue([{ channel: '1' }, { channel: '3' }]);

      await service.create('dev-1', {});

      expect(createdChannel()).toBe('4');
    });

    it('device ที่ยังไม่มี probe เลย → เริ่มที่ 1', async () => {
      prisma.probes.findMany.mockResolvedValue([]);

      await service.create('dev-1', {});

      expect(createdChannel()).toBe('1');
    });

    it('channel ที่ไม่ใช่ตัวเลขไม่ถูกนับ (อุปกรณ์บางรุ่นส่งชื่อช่องเป็นตัวอักษร)', async () => {
      prisma.probes.findMany.mockResolvedValue([{ channel: 'A' }, { channel: '2' }]);

      await service.create('dev-1', {});

      expect(createdChannel()).toBe('3');
    });
  });

  it('findAllByDevice คืน probe ทั้งหมดของ device นั้น พร้อม pagination meta', async () => {
    prisma.probes.findMany.mockResolvedValue([probe]);
    prisma.probes.count.mockResolvedValue(1);

    const result = await service.findAllByDevice('dev-1', { page: 1, limit: 20 });

    expect(prisma.probes.findMany).toHaveBeenCalledWith({
      where: { deviceId: 'dev-1' },
      skip: 0,
      take: 20,
    });
    expect(prisma.probes.count).toHaveBeenCalledWith({ where: { deviceId: 'dev-1' } });
    expect(result.data).toEqual([probe]);
    expect(result.meta).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  describe('findLatestTelemetryByDevice', () => {
    it('ไม่มี probe เลย → คืน [] โดยไม่ยิง query logDays', async () => {
      prisma.probes.findMany.mockResolvedValue([]);

      const result = await service.findLatestTelemetryByDevice('dev-1');

      expect(result).toEqual([]);
      expect(prisma.logDays.findMany).not.toHaveBeenCalled();
    });

    it('มี 2 probes มี log ของ probe เดียว → probe ที่ไม่มี log ได้ค่า null ทั้งหมด', async () => {
      prisma.probes.findMany.mockResolvedValue([
        { id: 'probe-1', channel: '1', name: 'P1', type: 'SHT-31', doorQty: 1 },
        { id: 'probe-2', channel: '2', name: 'P2', type: 'PT100', doorQty: 2 },
      ]);
      prisma.logDays.findMany.mockResolvedValue([
        {
          probeId: 'probe-1',
          temp: 4.5,
          tempDisplay: 4.5,
          humidity: 60,
          humidityDisplay: 60,
          door1: false,
          door2: false,
          door3: false,
          sendTime: new Date('2026-01-01T00:00:00Z'),
        },
      ]);

      const result = await service.findLatestTelemetryByDevice('dev-1');

      expect(prisma.logDays.findMany).toHaveBeenCalledWith({
        where: { probeId: { in: ['probe-1', 'probe-2'] } },
        orderBy: [{ probeId: 'asc' }, { sendTime: 'desc' }],
        distinct: ['probeId'],
      });
      expect(result).toEqual([
        {
          id: 'probe-1',
          channel: '1',
          name: 'P1',
          type: 'SHT-31',
          doorQty: 1,
          temp: 4.5,
          tempDisplay: 4.5,
          humidity: 60,
          humidityDisplay: 60,
          door1: false,
          door2: false,
          door3: false,
          sendTime: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: 'probe-2',
          channel: '2',
          name: 'P2',
          type: 'PT100',
          doorQty: 2,
          temp: null,
          tempDisplay: null,
          humidity: null,
          humidityDisplay: null,
          door1: null,
          door2: null,
          door3: null,
          sendTime: null,
        },
      ]);
    });
  });

  it('findOne โยน NotFoundException ถ้าไม่พบ probe', async () => {
    prisma.probes.findUnique.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update แก้ probe แล้ว emit probe.changed (updated)', async () => {
    prisma.probes.update.mockResolvedValue(probe);

    await service.update('probe-1', { name: 'P2' }, actor);

    expect(prisma.probes.update).toHaveBeenCalledWith({
      where: { id: 'probe-1' },
      data: { name: 'P2' },
    });
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.PROBE_CHANGED,
      expect.objectContaining({ action: 'updated' }),
    );
  });

  it('remove ลบ probe แล้ว emit probe.changed (deleted)', async () => {
    prisma.probes.delete.mockResolvedValue(probe);

    await service.remove('probe-1', actor);

    expect(prisma.probes.delete).toHaveBeenCalledWith({ where: { id: 'probe-1' } });
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.PROBE_CHANGED,
      expect.objectContaining({ action: 'deleted' }),
    );
  });

  it('emit ที่ throw ไม่ทำให้ mutation ล้มเหลว', async () => {
    prisma.probes.create.mockResolvedValue(probe);
    prisma.probes.findMany.mockResolvedValue([]);
    events.emit.mockImplementation(() => {
      throw new Error('listener boom');
    });

    await expect(service.create('dev-1', { name: 'P1' }, actor)).resolves.toEqual(probe);
  });
});
