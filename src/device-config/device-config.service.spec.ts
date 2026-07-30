import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { DeviceConfigService } from './device-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppEvents } from '../common/events/app-events';

describe('DeviceConfigService', () => {
  let service: DeviceConfigService;
  let prisma: {
    configs: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock; delete: jest.Mock };
  };
  let events: { emit: jest.Mock };

  const actor = { id: 'user-1', name: 'Somchai', role: 'ADMIN' };
  const config = { id: 'cfg-1', deviceId: 'dev-1', ssid: 'RDE3_2.4GHz' };

  beforeEach(async () => {
    prisma = {
      configs: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() },
    };
    events = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceConfigService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();

    service = module.get(DeviceConfigService);
  });

  it('create สร้าง config ผูกกับ deviceId จาก param แล้ว emit config.changed (created)', async () => {
    prisma.configs.create.mockResolvedValue(config);

    const result = await service.create('dev-1', { ssid: 'RDE3_2.4GHz' }, actor);

    expect(prisma.configs.create).toHaveBeenCalledWith({
      data: { ssid: 'RDE3_2.4GHz', deviceId: 'dev-1' },
    });
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.CONFIG_CHANGED,
      expect.objectContaining({ action: 'created', configId: 'cfg-1', deviceId: 'dev-1', actor }),
    );
    expect(result).toEqual(config);
  });

  it('findByDevice โยน NotFoundException ถ้าไม่พบ config', async () => {
    prisma.configs.findUnique.mockResolvedValue(null);

    await expect(service.findByDevice('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update แก้ config แล้ว emit config.changed (updated)', async () => {
    prisma.configs.update.mockResolvedValue(config);

    await service.update('dev-1', { ssid: 'NewSSID' }, actor);

    expect(prisma.configs.update).toHaveBeenCalledWith({
      where: { deviceId: 'dev-1' },
      data: { ssid: 'NewSSID' },
    });
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.CONFIG_CHANGED,
      expect.objectContaining({ action: 'updated' }),
    );
  });

  it('remove ลบ config แล้ว emit config.changed (deleted)', async () => {
    prisma.configs.delete.mockResolvedValue(config);

    await service.remove('dev-1', actor);

    expect(prisma.configs.delete).toHaveBeenCalledWith({ where: { deviceId: 'dev-1' } });
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.CONFIG_CHANGED,
      expect.objectContaining({ action: 'deleted' }),
    );
  });
});
