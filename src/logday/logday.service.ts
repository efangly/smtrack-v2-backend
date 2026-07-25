import { Injectable } from '@nestjs/common';
import { LogDays } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { UpdateLogdayDto } from './dto/update-logday.dto';

export interface DailyRollup {
  day: Date;
  deviceId: string;
  avgTemp: number;
  minTemp: number;
  maxTemp: number;
  samples: number;
}

/**
 * สรุปข้อมูลรายวันจาก TimescaleDB (scaffold)
 * production ควรใช้ continuous aggregate ของ TimescaleDB แทน raw query นี้
 *
 * เรื่อง timezone ของ NOW() ดูหมายเหตุใน graph.service.ts — ต้อง AT TIME ZONE 'UTC' เหมือนกัน
 */
@Injectable()
export class LogdayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** `deviceId` = จุดติดตั้ง ไม่ใช่ serial ของกล่อง (ดูเหตุผลใน LogDays.deviceId ของ schema) */
  summaryByDevice(deviceId: string, days = 7): Promise<DailyRollup[]> {
    return this.redis.getOrSet(
      `logday:${deviceId}:${days}`,
      60,
      () =>
        this.prisma.$queryRaw<DailyRollup[]>`
        SELECT time_bucket('1 day', "send_time") AS day,
               "device_id"     AS "deviceId",
               AVG("temp")     AS "avgTemp",
               MIN("temp")     AS "minTemp",
               MAX("temp")     AS "maxTemp",
               COUNT(*)::int   AS "samples"
        FROM "log_days"
        WHERE "device_id" = ${deviceId}
          AND "send_time" >= (NOW() AT TIME ZONE 'UTC') - (${days} || ' days')::interval
        GROUP BY day, "device_id"
        ORDER BY day DESC
      `,
    );
  }

  update(id: string, dto: UpdateLogdayDto): Promise<LogDays> {
    const { sendTime, ...rest } = dto;
    return this.prisma.logDays.update({
      where: { id },
      data: { ...rest, sendTime: sendTime ? new Date(sendTime) : undefined },
    });
  }

  remove(id: string): Promise<LogDays> {
    return this.prisma.logDays.delete({ where: { id } });
  }
}
