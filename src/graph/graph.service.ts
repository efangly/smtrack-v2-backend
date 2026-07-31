import { BadRequestException, Injectable } from '@nestjs/common';
import { LogDays, Probes } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GraphRange, QueryGraphDto } from './dto/query-graph.dto';

const RANGE_DAYS: Record<Exclude<GraphRange, GraphRange.CUSTOM>, number> = {
  [GraphRange.DAY]: 1,
  [GraphRange.WEEK]: 7,
  [GraphRange.MONTH]: 30,
};

/** channel ที่ใช้แทน series ของ log ที่ยังไม่ถูกผูก probe — ไม่ใช่ channel จริงของอุปกรณ์ */
export const UNASSIGNED_CHANNEL = 'unassigned';

/** หนึ่งเส้นในกราฟ = หนึ่ง probe พร้อม threshold ของมันเอง (แต่ละ probe ตั้งช่วงไม่เหมือนกัน) */
export interface ProbeSeries {
  /** null = series รวมของ log ที่ probe_id ยังว่าง (ก่อน backfill / กล่องยังไม่ถูกติดตั้ง) */
  probeId: string | null;
  channel: string;
  name: string | null;
  tempMin: number;
  tempMax: number;
  humiMin: number;
  humiMax: number;
  points: LogDays[];
}

/**
 * query สำหรับ dashboard กราฟ — คืนค่าดิบตามที่อุปกรณ์ส่งมาเสมอ (ไม่ average/downsample)
 * เพราะต้องใช้ตรวจสอบความแม่นยำ ไม่ใช่แค่ดู trend
 *
 * 1 device มีได้หลาย probe จึงคืนเป็นหลาย series แยกกัน ไม่ใช่ log ปนกันในกองเดียว
 */
@Injectable()
export class GraphService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** `deviceId` = จุดติดตั้ง ไม่ใช่ serial ของกล่อง จึงได้กราฟต่อเนื่องข้ามการสลับเครื่อง */
  async series(deviceId: string, query: QueryGraphDto): Promise<ProbeSeries[]> {
    const range = query.range ?? GraphRange.DAY;
    const { from, to } = this.resolveRange(range, query.from, query.to);
    const probeId = query.probeId;

    return this.redis.getOrSet(
      `graph:${deviceId}:${range}:${from.toISOString()}:${to.toISOString()}:${probeId ?? 'all'}`,
      30,
      async () => {
        const [probes, logs] = await Promise.all([
          this.prisma.probes.findMany({
            where: { deviceId, ...(probeId ? { id: probeId } : {}) },
            orderBy: { channel: 'asc' },
          }),
          this.prisma.logDays.findMany({
            where: {
              deviceId,
              sendTime: { gte: from, lte: to },
              ...(probeId ? { probeId } : {}),
            },
            orderBy: { sendTime: 'asc' },
          }),
        ]);

        return this.groupIntoSeries(probes, logs, probeId);
      },
    );
  }

  /**
   * ตั้งต้นจากรายการ probe ไม่ใช่จาก log ที่มี — probe ที่ไม่มีข้อมูลในช่วงนั้นต้องคืนเป็น
   * เส้นว่าง (`points: []`) ให้ frontend เห็นว่า "มี probe นี้อยู่แต่ไม่ส่งข้อมูล" ซึ่งเป็นสัญญาณ
   * ของ probe ที่หลุด/เสีย — ถ้าตัดออกไปเลยจะดูเหมือน device นี้ไม่เคยมี probe นั้น
   */
  private groupIntoSeries(probes: Probes[], logs: LogDays[], probeId?: string): ProbeSeries[] {
    const byProbeId = new Map<string, LogDays[]>(probes.map((p) => [p.id, []]));
    const unassigned: LogDays[] = [];

    for (const log of logs) {
      const bucket = log.probeId ? byProbeId.get(log.probeId) : undefined;
      if (bucket) bucket.push(log);
      else unassigned.push(log); // probe ถูกลบไปแล้ว หรือ probe_id ยังว่าง
    }

    const series: ProbeSeries[] = probes.map((p) => ({
      probeId: p.id,
      channel: p.channel,
      name: p.name,
      tempMin: p.tempMin,
      tempMax: p.tempMax,
      humiMin: p.humiMin,
      humiMax: p.humiMax,
      points: byProbeId.get(p.id) ?? [],
    }));

    // ไม่ทิ้ง log ที่ไม่มี probe เงียบ ๆ — ผู้ใช้ต้องเห็นว่ามีข้อมูลอยู่แต่ยังไม่ถูกจัดเข้า probe
    // ข้ามเมื่อ filter probeId มา เพราะผู้ใช้ขอเส้นเดียวที่เจาะจงไว้แล้ว
    if (!probeId && unassigned.length > 0) {
      series.push({
        probeId: null,
        channel: UNASSIGNED_CHANNEL,
        name: null,
        tempMin: 0,
        tempMax: 0,
        humiMin: 0,
        humiMax: 0,
        points: unassigned,
      });
    }

    return series;
  }

  private resolveRange(range: GraphRange, from?: string, to?: string): { from: Date; to: Date } {
    if (range === GraphRange.CUSTOM) {
      if (!from || !to) {
        throw new BadRequestException('from and to are required when range=custom');
      }
      return { from: new Date(from), to: new Date(to) };
    }

    const now = new Date();
    const days = RANGE_DAYS[range];
    return { from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), to: now };
  }
}
