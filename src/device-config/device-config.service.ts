import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Configs } from '../generated/prisma/client';
import { AppEvents } from '../common/events/app-events';
import { ConfigChangeAction, buildConfigChangedEvent } from '../common/events/config-changed.event';
import { DeviceChangeActor } from '../common/events/device-changed.event';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDeviceConfigDto } from './dto/create-device-config.dto';
import { UpdateDeviceConfigDto } from './dto/update-device-config.dto';

@Injectable()
export class DeviceConfigService {
  private readonly logger = new Logger(DeviceConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  private emitChanged(
    action: ConfigChangeAction,
    config: Configs,
    actor?: DeviceChangeActor,
  ): void {
    try {
      this.events.emit(AppEvents.CONFIG_CHANGED, buildConfigChangedEvent(action, config, actor));
    } catch (err) {
      this.logger.warn(`emit config.changed (${action}) ล้มเหลว: ${(err as Error).message}`);
    }
  }

  async create(
    deviceId: string,
    dto: CreateDeviceConfigDto,
    actor?: DeviceChangeActor,
  ): Promise<Configs> {
    const config = await this.prisma.configs.create({ data: { ...dto, deviceId } });
    this.emitChanged('created', config, actor);
    return config;
  }

  async findByDevice(deviceId: string): Promise<Configs> {
    const config = await this.prisma.configs.findUnique({ where: { deviceId } });
    if (!config) {
      throw new NotFoundException(`Config for device ${deviceId} not found`);
    }
    return config;
  }

  async update(
    deviceId: string,
    dto: UpdateDeviceConfigDto,
    actor?: DeviceChangeActor,
  ): Promise<Configs> {
    const config = await this.prisma.configs.update({ where: { deviceId }, data: dto });
    this.emitChanged('updated', config, actor);
    return config;
  }

  async remove(deviceId: string, actor?: DeviceChangeActor): Promise<Configs> {
    const config = await this.prisma.configs.delete({ where: { deviceId } });
    this.emitChanged('deleted', config, actor);
    return config;
  }
}
