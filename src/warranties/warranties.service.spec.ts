import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { WarrantiesService } from './warranties.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppEvents } from '../common/events/app-events';

describe('WarrantiesService', () => {
  let service: WarrantiesService;
  let prisma: {
    warranties: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
  };
  let events: { emit: jest.Mock };

  const actor = { id: 'user-1', name: 'Somchai', role: 'ADMIN' };
  const warranty = { id: 'war-1', serial: 'SN-1', devName: 'Fridge 1' };

  beforeEach(async () => {
    prisma = {
      warranties: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
    };
    events = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WarrantiesService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();

    service = module.get(WarrantiesService);
  });

  it('create สร้างรายการประกันแล้ว emit warranty.changed (created)', async () => {
    prisma.warranties.create.mockResolvedValue(warranty);

    const result = await service.create({ serial: 'SN-1', devName: 'Fridge 1' }, actor);

    expect(prisma.warranties.create).toHaveBeenCalledWith({
      data: { serial: 'SN-1', devName: 'Fridge 1' },
    });
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.WARRANTY_CHANGED,
      expect.objectContaining({ action: 'created', warrantyId: 'war-1', serial: 'SN-1', actor }),
    );
    expect(result).toEqual(warranty);
  });

  it('findBySerial กรองด้วย serial เรียงใหม่ไปเก่า', async () => {
    prisma.warranties.findMany.mockResolvedValue([warranty]);

    await service.findBySerial('SN-1');

    expect(prisma.warranties.findMany).toHaveBeenCalledWith({
      where: { serial: 'SN-1' },
      orderBy: { createAt: 'desc' },
    });
  });

  it('findOne โยน NotFoundException ถ้าไม่พบรายการประกัน', async () => {
    prisma.warranties.findUnique.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update ตัด serial ออกจาก dto ก่อนเขียน แล้ว emit warranty.changed (updated)', async () => {
    prisma.warranties.update.mockResolvedValue(warranty);

    await service.update('war-1', { serial: 'SN-2', status: false }, actor);

    expect(prisma.warranties.update).toHaveBeenCalledWith({
      where: { id: 'war-1' },
      data: { status: false },
    });
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.WARRANTY_CHANGED,
      expect.objectContaining({ action: 'updated' }),
    );
  });
});
