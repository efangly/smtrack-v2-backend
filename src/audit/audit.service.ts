import { Injectable } from '@nestjs/common';
import { DeviceAudit, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceChangeAction, DeviceChangeActor } from '../common/events/device-changed.event';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';
import { paginationSkip, toPaginated } from '../common/pagination/paginate.util';

export interface RecordDeviceAuditInput {
  deviceId: string;
  staticName: string;
  action: DeviceChangeAction;
  actor?: DeviceChangeActor;
  snapshot: Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(input: RecordDeviceAuditInput): Promise<DeviceAudit> {
    return this.prisma.deviceAudit.create({
      data: {
        deviceId: input.deviceId,
        staticName: input.staticName,
        action: input.action,
        actorId: input.actor?.id,
        actorName: input.actor?.name,
        actorRole: input.actor?.role,
        snapshot: input.snapshot,
      },
    });
  }

  async findByDevice(
    deviceId: string,
    pagination: PaginationQueryDto,
  ): Promise<Paginated<DeviceAudit>> {
    const [data, total] = await Promise.all([
      this.prisma.deviceAudit.findMany({
        where: { deviceId },
        orderBy: { createAt: 'desc' },
        skip: paginationSkip(pagination),
        take: pagination.limit ?? 20,
      }),
      this.prisma.deviceAudit.count({ where: { deviceId } }),
    ]);
    return toPaginated(data, total, pagination);
  }
}
