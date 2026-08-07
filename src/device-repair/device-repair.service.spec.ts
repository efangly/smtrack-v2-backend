import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { DeviceRepairService } from './device-repair.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppEvents } from '../common/events/app-events';

describe('DeviceRepairService', () => {
  let service: DeviceRepairService;
  let prisma: {
    repairs: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };
  let events: { emit: jest.Mock };

  const actor = { id: 'user-1', name: 'Somchai', role: 'ADMIN' };
  const repair = { id: 'rep-1', serial: 'SN-1', devName: 'Fridge 1' };

  beforeEach(async () => {
    prisma = {
      repairs: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    events = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceRepairService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();

    service = module.get(DeviceRepairService);
  });

  it('create สร้างรายการซ่อมแล้ว emit repair.changed (created)', async () => {
    prisma.repairs.create.mockResolvedValue(repair);

    const result = await service.create({ serial: 'SN-1', devName: 'Fridge 1' }, actor);

    expect(prisma.repairs.create).toHaveBeenCalledWith({
      data: { serial: 'SN-1', devName: 'Fridge 1' },
    });
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.REPAIR_CHANGED,
      expect.objectContaining({ action: 'created', repairId: 'rep-1', serial: 'SN-1', actor }),
    );
    expect(result).toEqual(repair);
  });

  it('findBySerial กรองด้วย serial เรียงใหม่ไปเก่า', async () => {
    prisma.repairs.findMany.mockResolvedValue([repair]);

    await service.findBySerial('SN-1');

    expect(prisma.repairs.findMany).toHaveBeenCalledWith({
      where: { serial: 'SN-1' },
      orderBy: { createAt: 'desc' },
    });
  });

  it('findOne โยน NotFoundException ถ้าไม่พบรายการซ่อม', async () => {
    prisma.repairs.findUnique.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update ตัด serial ออกจาก dto ก่อนเขียน แล้ว emit repair.changed (updated)', async () => {
    prisma.repairs.update.mockResolvedValue(repair);

    await service.update('rep-1', { serial: 'SN-2', status: 'closed' }, actor);

    expect(prisma.repairs.update).toHaveBeenCalledWith({
      where: { id: 'rep-1' },
      data: { status: 'closed' },
    });
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.REPAIR_CHANGED,
      expect.objectContaining({ action: 'updated' }),
    );
  });

  it('remove ลบรายการซ่อมแล้ว emit repair.changed (deleted)', async () => {
    prisma.repairs.findUnique.mockResolvedValue(repair);
    prisma.repairs.delete.mockResolvedValue(repair);

    const result = await service.remove('rep-1', actor);

    expect(prisma.repairs.delete).toHaveBeenCalledWith({ where: { id: 'rep-1' } });
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.REPAIR_CHANGED,
      expect.objectContaining({ action: 'deleted', repairId: 'rep-1' }),
    );
    expect(result).toEqual(repair);
  });

  it('remove โยน NotFoundException ถ้าไม่พบรายการซ่อม', async () => {
    prisma.repairs.findUnique.mockResolvedValue(null);

    await expect(service.remove('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.repairs.delete).not.toHaveBeenCalled();
  });
});
