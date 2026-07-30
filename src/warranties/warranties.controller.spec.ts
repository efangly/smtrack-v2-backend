import { Test, TestingModule } from '@nestjs/testing';
import { WarrantiesController } from './warranties.controller';
import { WarrantiesService } from './warranties.service';

describe('WarrantiesController', () => {
  let controller: WarrantiesController;
  let warrantiesService: {
    create: jest.Mock;
    findAll: jest.Mock;
    findBySerial: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };

  const user = { id: 'user-1', name: 'Somchai', role: 'ADMIN', wardId: 'ward-1' };
  const req = { user } as never;

  beforeEach(async () => {
    warrantiesService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findBySerial: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WarrantiesController],
      providers: [{ provide: WarrantiesService, useValue: warrantiesService }],
    }).compile();

    controller = module.get(WarrantiesController);
  });

  it('create ส่ง dto และ actor จาก JWT ให้ service', async () => {
    warrantiesService.create.mockResolvedValue({ id: 'war-1' });

    await controller.create({ serial: 'SN-1' }, req);

    expect(warrantiesService.create).toHaveBeenCalledWith({ serial: 'SN-1' }, user);
  });

  it('findBySerial เรียก service ด้วย serial', async () => {
    warrantiesService.findBySerial.mockResolvedValue([]);

    await controller.findBySerial('SN-1');

    expect(warrantiesService.findBySerial).toHaveBeenCalledWith('SN-1');
  });

  it('update ส่ง id, dto และ actor ให้ service', async () => {
    warrantiesService.update.mockResolvedValue({ id: 'war-1' });

    await controller.update('war-1', { status: false }, req);

    expect(warrantiesService.update).toHaveBeenCalledWith('war-1', { status: false }, user);
  });
});
