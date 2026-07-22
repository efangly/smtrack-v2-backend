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
 */
@Injectable()
export class GraphService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  series(serial: string, bucket = '1 hour', hours = 24): Promise<GraphPoint[]> {
    return this.redis.getOrSet(
      `graph:${serial}:${bucket}:${hours}`,
      45,
      () =>
        this.prisma.$queryRaw<GraphPoint[]>`
        SELECT time_bucket(${bucket}::interval, "send_time") AS bucket,
               AVG("temp")     AS "avgTemp",
               AVG("humidity") AS "avgHumidity"
        FROM "log_days"
        WHERE "serial" = ${serial}
          AND "send_time" >= NOW() - (${hours} || ' hours')::interval
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
    );
  }
}
