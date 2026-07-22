import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export interface DailyRollup {
  day: Date;
  serial: string;
  avgTemp: number;
  minTemp: number;
  maxTemp: number;
  samples: number;
}

/**
 * สรุปข้อมูลรายวันจาก TimescaleDB (scaffold)
 * production ควรใช้ continuous aggregate ของ TimescaleDB แทน raw query นี้
 */
@Injectable()
export class LogdayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  summaryBySerial(serial: string, days = 7): Promise<DailyRollup[]> {
    return this.redis.getOrSet(
      `logday:${serial}:${days}`,
      60,
      () =>
        this.prisma.$queryRaw<DailyRollup[]>`
        SELECT time_bucket('1 day', "send_time") AS day,
               "serial",
               AVG("temp")     AS "avgTemp",
               MIN("temp")     AS "minTemp",
               MAX("temp")     AS "maxTemp",
               COUNT(*)::int   AS "samples"
        FROM "log_days"
        WHERE "serial" = ${serial}
          AND "send_time" >= NOW() - (${days} || ' days')::interval
        GROUP BY day, "serial"
        ORDER BY day DESC
      `,
    );
  }
}
