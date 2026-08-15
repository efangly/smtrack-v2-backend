import { Injectable } from '@nestjs/common';
import { DeviceAudit, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceChangeAction, DeviceChangeActor } from '../common/events/device-changed.event';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';
import { paginationSkip, toPaginated } from '../common/pagination/paginate.util';
import { FieldDiff, computeSnapshotDiff } from './audit-diff.util';

export interface RecordDeviceAuditInput {
  deviceId: string;
  staticName: string;
  action: DeviceChangeAction;
  actor?: DeviceChangeActor;
  snapshot: Prisma.InputJsonValue;
}

/** แถว audit ที่ตอบออกไปให้ client — แทน `snapshot` เต็มก้อนด้วย `diff` ที่เทียบกับแถวก่อนหน้าแล้ว */
export type DeviceAuditEntry = Omit<DeviceAudit, 'snapshot'> & { diff: FieldDiff | null };

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

  /**
   * ประวัติของจุดติดตั้ง พร้อม diff ต่อแถว (เทียบ snapshot กับแถวก่อนหน้าของ device เดียวกัน)
   *
   * ดึงมาเกินหน้าละ 1 แถวเสมอ เพื่อใช้เป็น "แถวก่อนหน้า" ของแถวที่เก่าที่สุดในหน้านั้น
   * โดยไม่ต้องยิง query เพิ่ม — ดู ADR-0001 สำหรับเหตุผลที่ diff ถูกคำนวณตอนอ่านแทนที่จะ persist
   */
  async findByDevice(
    deviceId: string,
    pagination: PaginationQueryDto,
  ): Promise<Paginated<DeviceAuditEntry>> {
    const take = pagination.limit ?? 20;
    const [rows, total] = await Promise.all([
      this.prisma.deviceAudit.findMany({
        where: { deviceId },
        orderBy: { createAt: 'desc' },
        skip: paginationSkip(pagination),
        take: take + 1,
      }),
      this.prisma.deviceAudit.count({ where: { deviceId } }),
    ]);

    const data = rows.slice(0, take).map((row, i) => {
      const older = rows[i + 1];
      const { snapshot, ...rest } = row;
      const diff =
        row.action === 'created' || !older
          ? null
          : computeSnapshotDiff(
              older.snapshot as Record<string, unknown>,
              snapshot as Record<string, unknown>,
            );
      return { ...rest, diff };
    });

    return toPaginated(data, total, pagination);
  }
}
