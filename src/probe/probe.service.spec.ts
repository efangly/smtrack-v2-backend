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

    const result = await service.create('dev-1', { name: 'P1' }, actor);

    expect(prisma.probes.create).toHaveBeenCalledWith({
      data: { name: 'P1', deviceId: 'dev-1' },
    });
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.PROBE_CHANGED,
      expect.objectContaining({ action: 'created', probeId: 'probe-1', deviceId: 'dev-1', actor }),
    );
    expect(result).toEqual(probe);
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
    events.emit.mockImplementation(() => {
      throw new Error('listener boom');
    });

    await expect(service.create('dev-1', { name: 'P1' }, actor)).resolves.toEqual(probe);
  });
});
