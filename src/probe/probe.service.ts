import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Probes } from '../generated/prisma/client';
import { AppEvents } from '../common/events/app-events';
import { ProbeChangeAction, buildProbeChangedEvent } from '../common/events/probe-changed.event';
import { DeviceChangeActor } from '../common/events/device-changed.event';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProbeDto } from './dto/create-probe.dto';
import { UpdateProbeDto } from './dto/update-probe.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';
import { paginationSkip, toPaginated } from '../common/pagination/paginate.util';

@Injectable()
export class ProbeService {
  private readonly logger = new Logger(ProbeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  private emitChanged(action: ProbeChangeAction, probe: Probes, actor?: DeviceChangeActor): void {
    try {
      this.events.emit(AppEvents.PROBE_CHANGED, buildProbeChangedEvent(action, probe, actor));
    } catch (err) {
      this.logger.warn(`emit probe.changed (${action}) ล้มเหลว: ${(err as Error).message}`);
    }
  }

  async create(deviceId: string, dto: CreateProbeDto, actor?: DeviceChangeActor): Promise<Probes> {
    const probe = await this.prisma.probes.create({ data: { ...dto, deviceId } });
    this.emitChanged('created', probe, actor);
    return probe;
  }

  async findAllByDevice(
    deviceId: string,
    pagination: PaginationQueryDto,
  ): Promise<Paginated<Probes>> {
    const [data, total] = await Promise.all([
      this.prisma.probes.findMany({
        where: { deviceId },
        skip: paginationSkip(pagination),
        take: pagination.limit ?? 20,
      }),
      this.prisma.probes.count({ where: { deviceId } }),
    ]);
    return toPaginated(data, total, pagination);
  }

  async findOne(id: string): Promise<Probes> {
    const probe = await this.prisma.probes.findUnique({ where: { id } });
    if (!probe) {
      throw new NotFoundException(`Probe ${id} not found`);
    }
    return probe;
  }

  async update(id: string, dto: UpdateProbeDto, actor?: DeviceChangeActor): Promise<Probes> {
    const probe = await this.prisma.probes.update({ where: { id }, data: dto });
    this.emitChanged('updated', probe, actor);
    return probe;
  }

  async remove(id: string, actor?: DeviceChangeActor): Promise<Probes> {
    const probe = await this.prisma.probes.delete({ where: { id } });
    this.emitChanged('deleted', probe, actor);
    return probe;
  }
}
