import { NotFoundException } from '@nestjs/common';
import { DeviceAssignmentService } from '../device/device-assignment.service';
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

  const user = {
    id: 'user-1',
    name: 'Somchai',
    role: 'ADMIN',
    scope: { kind: 'TENANT' as const, tenantId: 'tenant-1', departments: 'ALL' as const },
  };
  const req = { user } as never;

  let assignments: { assertDeviceAccess: jest.Mock };

  beforeEach(async () => {
    assignments = { assertDeviceAccess: jest.fn().mockResolvedValue(undefined) };
    configService = {
      create: jest.fn(),
      findByDevice: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeviceConfigController],
      providers: [
        { provide: DeviceConfigService, useValue: configService },
        { provide: DeviceAssignmentService, useValue: assignments },
      ],
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

    await controller.findByDevice('dev-1', req);

    expect(assignments.assertDeviceAccess).toHaveBeenCalledWith(user.scope, 'dev-1');
    expect(configService.findByDevice).toHaveBeenCalledWith('dev-1');
  });

  it('จุดติดตั้งนอก scope ถูกปฏิเสธก่อนถึง service ทุก route', async () => {
    assignments.assertDeviceAccess.mockRejectedValue(new NotFoundException());

    await expect(controller.findByDevice('dev-2', req)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.update('dev-2', { ssid: 'X' }, req)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(controller.remove('dev-2', req)).rejects.toBeInstanceOf(NotFoundException);
    expect(configService.findByDevice).not.toHaveBeenCalled();
    expect(configService.update).not.toHaveBeenCalled();
    expect(configService.remove).not.toHaveBeenCalled();
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
