import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export interface GraphPoint {
  bucket: Date;
  avgTemp: number;
  avgHumidity: number;
}

/**
 * query/aggregate สำหรับ dashboard กราฟ (scaffold)
 * time_bucket ตาม interval ที่ระบุ
 *
 * หมายเหตุเรื่อง timezone: "send_time" เป็น timestamp without time zone ที่ Prisma เขียนเป็น UTC
 * แต่ NOW() คืน timestamptz ซึ่งเวลาถูกเทียบกับคอลัมน์จะถูก cast เป็นเวลาท้องถิ่นของ DB
 * (โปรดักชันตั้งเป็น Asia/Bangkok) ทำให้ช่วงเวลาเพี้ยนไป 7 ชม. — ต้อง AT TIME ZONE 'UTC' เสมอ
 */
@Injectable()
export class GraphService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** `deviceId` = จุดติดตั้ง ไม่ใช่ serial ของกล่อง จึงได้กราฟต่อเนื่องข้ามการสลับเครื่อง */
  series(deviceId: string, bucket = '1 hour', hours = 24): Promise<GraphPoint[]> {
    return this.redis.getOrSet(
      `graph:${deviceId}:${bucket}:${hours}`,
      45,
      () =>
        this.prisma.$queryRaw<GraphPoint[]>`
        SELECT time_bucket(${bucket}::interval, "send_time") AS bucket,
               AVG("temp")     AS "avgTemp",
               AVG("humidity") AS "avgHumidity"
        FROM "log_days"
        WHERE "device_id" = ${deviceId}
          AND "send_time" >= (NOW() AT TIME ZONE 'UTC') - (${hours} || ' hours')::interval
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
    );
  }
}
