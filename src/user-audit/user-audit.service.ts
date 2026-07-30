import { Injectable } from '@nestjs/common';
import { Prisma, UserAudit } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceChangeActor } from '../common/events/device-changed.event';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';
import { paginationSkip, toPaginated } from '../common/pagination/paginate.util';

export interface RecordUserAuditInput {
  entityType: string;
  entityId: string;
  action: string;
  actor?: DeviceChangeActor;
  snapshot: Prisma.InputJsonValue;
}

@Injectable()
export class UserAuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(input: RecordUserAuditInput): Promise<UserAudit> {
    return this.prisma.userAudit.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        actorId: input.actor?.id,
        actorName: input.actor?.name,
        actorRole: input.actor?.role,
        snapshot: input.snapshot,
      },
    });
  }

  async findByActor(
    actorId: string,
    pagination: PaginationQueryDto,
  ): Promise<Paginated<UserAudit>> {
    const [data, total] = await Promise.all([
      this.prisma.userAudit.findMany({
        where: { actorId },
        orderBy: { createAt: 'desc' },
        skip: paginationSkip(pagination),
        take: pagination.limit ?? 20,
      }),
      this.prisma.userAudit.count({ where: { actorId } }),
    ]);
    return toPaginated(data, total, pagination);
  }
}
