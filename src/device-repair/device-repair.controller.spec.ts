import { Test, TestingModule } from '@nestjs/testing';
import { DeviceRepairController } from './device-repair.controller';
import { DeviceRepairService } from './device-repair.service';
import { RepairStatus } from './enums/repair-status.enum';

describe('DeviceRepairController', () => {
  let controller: DeviceRepairController;
  let repairService: {
    create: jest.Mock;
    findAll: jest.Mock;
    findBySerial: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };

  const user = { id: 'user-1', name: 'Somchai', role: 'ADMIN', wardId: 'ward-1' };
  const req = { user } as never;

  beforeEach(async () => {
    repairService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findBySerial: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeviceRepairController],
      providers: [{ provide: DeviceRepairService, useValue: repairService }],
    }).compile();

    controller = module.get(DeviceRepairController);
  });

  it('create ส่ง dto และ actor จาก JWT ให้ service', async () => {
    repairService.create.mockResolvedValue({ id: 'rep-1' });

    await controller.create({ serial: 'SN-1' }, req);

    expect(repairService.create).toHaveBeenCalledWith({ serial: 'SN-1' }, user);
  });

  it('findBySerial เรียก service ด้วย serial', async () => {
    repairService.findBySerial.mockResolvedValue([]);

    await controller.findBySerial('SN-1');

    expect(repairService.findBySerial).toHaveBeenCalledWith('SN-1');
  });

  it('update ส่ง id, dto และ actor ให้ service', async () => {
    repairService.update.mockResolvedValue({ id: 'rep-1' });

    await controller.update('rep-1', { status: RepairStatus.RESOLVED }, req);

    expect(repairService.update).toHaveBeenCalledWith(
      'rep-1',
      { status: RepairStatus.RESOLVED },
      user,
    );
  });
});
