import { Test, TestingModule } from '@nestjs/testing';
import { DeviceConfigController } from './device-config.controller';
import { DeviceConfigService } from './device-config.service';

describe('DeviceConfigController', () => {
  let controller: DeviceConfigController;
  let configService: {
    create: jest.Mock;
    findByDevice: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  const user = { id: 'user-1', name: 'Somchai', role: 'ADMIN', wardId: 'ward-1' };
  const req = { user } as never;

  beforeEach(async () => {
    configService = {
      create: jest.fn(),
      findByDevice: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeviceConfigController],
      providers: [{ provide: DeviceConfigService, useValue: configService }],
    }).compile();

    controller = module.get(DeviceConfigController);
  });

  it('create ส่ง deviceId, dto และ actor จาก JWT ให้ service', async () => {
    configService.create.mockResolvedValue({ id: 'cfg-1' });

    await controller.create('dev-1', { ssid: 'RDE3' }, req);

    expect(configService.create).toHaveBeenCalledWith('dev-1', { ssid: 'RDE3' }, user);
  });

  it('findByDevice เรียก service ด้วย deviceId', async () => {
    configService.findByDevice.mockResolvedValue({ id: 'cfg-1' });

    await controller.findByDevice('dev-1');

    expect(configService.findByDevice).toHaveBeenCalledWith('dev-1');
  });

  it('update ส่ง deviceId, dto และ actor ให้ service', async () => {
    configService.update.mockResolvedValue({ id: 'cfg-1' });

    await controller.update('dev-1', { ssid: 'New' }, req);

    expect(configService.update).toHaveBeenCalledWith('dev-1', { ssid: 'New' }, user);
  });

  it('remove ส่ง deviceId และ actor ให้ service', async () => {
    configService.remove.mockResolvedValue({ id: 'cfg-1' });

    await controller.remove('dev-1', req);

    expect(configService.remove).toHaveBeenCalledWith('dev-1', user);
  });
});
