import { Test, TestingModule } from '@nestjs/testing';
import { ProbeController } from './probe.controller';
import { ProbeService } from './probe.service';

describe('ProbeController', () => {
  let controller: ProbeController;
  let probeService: {
    create: jest.Mock;
    findAllByDevice: jest.Mock;
    findLatestTelemetryByDevice: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  const user = { id: 'user-1', name: 'Somchai', role: 'ADMIN', wardId: 'ward-1' };
  const req = { user } as never;

  beforeEach(async () => {
    probeService = {
      create: jest.fn(),
      findAllByDevice: jest.fn(),
      findLatestTelemetryByDevice: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: ProbeService, useValue: probeService }],
    }).compile();

    controller = module.get(ProbeController);
  });

  it('create ส่ง deviceId, dto และ actor จาก JWT ให้ service', async () => {
    probeService.create.mockResolvedValue({ id: 'probe-1' });

    await controller.create('dev-1', { name: 'P1' }, req);

    expect(probeService.create).toHaveBeenCalledWith('dev-1', { name: 'P1' }, user);
  });

  it('findAllByDevice เรียก service ด้วย deviceId', async () => {
    probeService.findAllByDevice.mockResolvedValue({ data: [], meta: {} });

    const pagination = { page: 1, limit: 20 };
    await controller.findAllByDevice('dev-1', pagination);

    expect(probeService.findAllByDevice).toHaveBeenCalledWith('dev-1', pagination);
  });

  it('findLatestTelemetryByDevice เรียก service ด้วย deviceId', async () => {
    probeService.findLatestTelemetryByDevice.mockResolvedValue([]);

    await controller.findLatestTelemetryByDevice('dev-1');

    expect(probeService.findLatestTelemetryByDevice).toHaveBeenCalledWith('dev-1');
  });

  it('update ส่ง id, dto และ actor ให้ service', async () => {
    probeService.update.mockResolvedValue({ id: 'probe-1' });

    await controller.update('probe-1', { name: 'P2' }, req);

    expect(probeService.update).toHaveBeenCalledWith('probe-1', { name: 'P2' }, user);
  });

  it('remove ส่ง id และ actor ให้ service', async () => {
    probeService.remove.mockResolvedValue({ id: 'probe-1' });

    await controller.remove('probe-1', req);

    expect(probeService.remove).toHaveBeenCalledWith('probe-1', user);
  });
});
