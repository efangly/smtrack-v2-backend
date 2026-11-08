import { Injectable } from '@nestjs/common';
import { Devices, Notifications, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { deviceWhere, scopeKey } from '../common/auth/access-scope';

@Injectable()
export class MobileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** กรองตาม scope (tenant/department) ของผู้ใช้ */
  findNotification(user: JwtPayloadDto): Promise<Notifications[]> {
    const { conditions, key } = this.findCondition(user);
    return this.redis.getOrSet(key, 15, () =>
      this.prisma.notifications.findMany({
        take: 99,
        where: conditions,
        orderBy: { createAt: 'desc' },
      }),
    );
  }

  /**
   * 1 device มีได้หลาย probe จึงต้องคืน "ค่าล่าสุดต่อ probe" ไม่ใช่แถวล่าสุดแถวเดียวของ device
   * (แบบเดิมได้ค่าของ probe ที่เผอิญส่งมาล่าสุด ตัวอื่นหายไปทั้งหมด)
   */
  findByDepartment(departmentId: string, user: JwtPayloadDto): Promise<Devices[]> {
    // AND กับ scope แทนการรวม object — ไม่งั้น departmentId ที่ขอมาจะทับเงื่อนไข department ของ scope
    // department นอก scope จึงได้รายการว่าง ไม่ยืนยันว่ามีอยู่จริง
    const key = `mobile:dept:${departmentId}:${scopeKey(user.scope)}`;
    return this.redis.getOrSet(key, 15, () =>
      this.prisma.devices.findMany({
        where: { AND: [deviceWhere(user.scope), { departmentId }] },
        include: {
          probe: {
            orderBy: { channel: 'asc' },
            include: { log: { take: 1, orderBy: { sendTime: 'desc' } } },
          },
          notification: { orderBy: { createAt: 'desc' } },
        },
        orderBy: { seq: 'asc' },
      }),
    );
  }

  private findCondition(user: JwtPayloadDto): {
    conditions: Prisma.NotificationsWhereInput | undefined;
    key: string;
  } {
    if (user.scope.kind === 'GLOBAL') return { conditions: undefined, key: 'mobile-notification' };
    return {
      conditions: { device: deviceWhere(user.scope) },
      key: `mobile-notification:${scopeKey(user.scope)}`,
    };
  }
}
