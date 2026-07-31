import { Injectable } from '@nestjs/common';
import { LogDays } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { UpdateLogdayDto } from './dto/update-logday.dto';

export interface DailyRollup {
  day: Date;
  deviceId: string;
  /** null = log ที่ยังไม่ถูกผูก probe (ข้อมูลก่อน backfill / กล่องที่ยังไม่ถูกติดตั้ง) */
  probeId: string | null;
  /** channel ดิบจาก log — มีค่าเสมอแม้ probeId เป็น null */
  channel: string;
  name: string | null;
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

  /**
   * `deviceId` = จุดติดตั้ง ไม่ใช่ serial ของกล่อง (ดูเหตุผลใน LogDays.deviceId ของ schema)
   *
   * แยก bucket ต่อ probe ด้วย: 1 device มีได้หลาย probe และแต่ละตัววัดคนละจุด/คนละช่วงอุณหภูมิ
   * ถ้า GROUP BY แค่ device (พฤติกรรมเดิม) ค่า avg/min/max จะเป็นการเฉลี่ยข้าม probe
   * ซึ่งไม่ได้แทนอะไรเลยในทางกายภาพ
   *
   * LEFT JOIN เพราะ log ที่ probe_id เป็น null ต้องยังอยู่ในผลลัพธ์ (ไม่ใช่หายเงียบ ๆ)
   * โดย fallback ไปแสดง channel ดิบจาก log_days.probe แทน
   */
  summaryByDevice(deviceId: string, days = 7): Promise<DailyRollup[]> {
    return this.redis.getOrSet(
      `logday:${deviceId}:${days}`,
      60,
      () =>
        this.prisma.$queryRaw<DailyRollup[]>`
        SELECT time_bucket('1 day', l."send_time") AS day,
               l."device_id"    AS "deviceId",
               l."probe_id"     AS "probeId",
               l."probe"        AS "channel",
               p."name"         AS "name",
               AVG(l."temp")    AS "avgTemp",
               MIN(l."temp")    AS "minTemp",
               MAX(l."temp")    AS "maxTemp",
               COUNT(*)::int    AS "samples"
        FROM "log_days" l
        LEFT JOIN "probes" p ON p."id" = l."probe_id"
        WHERE l."device_id" = ${deviceId}
          AND l."send_time" >= (NOW() AT TIME ZONE 'UTC') - (${days} || ' days')::interval
        GROUP BY day, l."device_id", l."probe_id", l."probe", p."name"
        ORDER BY day DESC, l."probe" ASC
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
