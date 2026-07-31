import { Injectable } from '@nestjs/common';
import { Devices, Notifications, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { JwtPayloadDto } from '../common/dto/payload.dto';

@Injectable()
export class MobileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** role scoping ตาม ward เท่านั้น — v2 schema ตัด hospital ออกแล้ว */
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
  findWard(ward: string): Promise<Devices[]> {
    return this.redis.getOrSet(`mobile:${ward}`, 15, () =>
      this.prisma.devices.findMany({
        where: { ward },
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
    switch (user.role) {
      case 'USER':
      case 'GUEST':
      case 'LEGACY_USER':
        return {
          conditions: { device: { ward: user.wardId } },
          key: `mobile-notification:${user.wardId}`,
        };
      default:
        return { conditions: undefined, key: 'mobile-notification' };
    }
  }
}
