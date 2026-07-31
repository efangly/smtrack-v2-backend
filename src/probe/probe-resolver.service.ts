import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '../generated/prisma/client';
import { AppEvents } from '../common/events/app-events';
import { buildProbeChangedEvent } from '../common/events/probe-changed.event';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** TTL สั้น ๆ ก็พอ — mapping (deviceId, channel) -> probeId แทบไม่เปลี่ยน แต่ถ้า admin ลบ probe
 * แล้ว cache ค้าง จะยิง FK ที่ไม่มีอยู่จริง (ingest พัง) จึงไม่เก็บนานและ invalidate ตาม event ด้วย */
const PROBE_ID_TTL_SECONDS = 300;

export const probeIdCacheKey = (deviceId: string, channel: string): string =>
  `probe:${deviceId}:${channel}`;

/**
 * แปลง channel ที่อุปกรณ์ส่งมาใน payload ให้เป็น `Probes.id` สำหรับผูกกับ log/notification
 *
 * แยกออกมาจาก ProbeService เพราะเป็น concern ของ "hot path ตอน ingest" ไม่ใช่ CRUD ของ admin:
 * ต้อง cache, ต้องทน race, และต้อง auto-provision — ซึ่ง CRUD ไม่ควรทำ
 */
@Injectable()
export class ProbeResolverService {
  private readonly logger = new Logger(ProbeResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * คืน `probeId` ของ (deviceId, channel) — สร้าง Probes row ใหม่ให้ถ้ายังไม่มี
   *
   * auto-provision เพราะอุปกรณ์เสียบ probe เพิ่มได้เองหน้างาน (จาก 2 เป็น 3 ช่อง) ถ้า reject
   * ข้อมูลจะหายจนกว่า admin จะมาสร้าง probe ให้ ซึ่งไม่มีใครรู้ว่าต้องทำ — ค่า threshold
   * ที่ได้เป็น default ของ schema ทั้งหมด admin มาแก้ทีหลังได้
   */
  async resolveProbeId(deviceId: string, channel: string): Promise<string> {
    return this.redis.getOrSet(probeIdCacheKey(deviceId, channel), PROBE_ID_TTL_SECONDS, () =>
      this.lookupOrCreate(deviceId, channel),
    );
  }

  private async lookupOrCreate(deviceId: string, channel: string): Promise<string> {
    const existing = await this.prisma.probes.findUnique({
      where: { deviceId_channel: { deviceId, channel } },
      select: { id: true },
    });
    if (existing) return existing.id;

    try {
      const probe = await this.prisma.probes.create({
        data: { deviceId, channel, name: `P${channel}` },
      });
      this.logger.log(`auto-provision probe channel ${channel} ให้ device ${deviceId}`);

      // ยิง event ให้ audit listener บันทึกไว้ด้วย — probe ที่โผล่มาเองต้องตามรอยได้
      // ไม่มี actor เพราะเป็น system-triggered (มาจาก payload ของอุปกรณ์ ไม่ใช่ผู้ใช้)
      try {
        this.events.emit(AppEvents.PROBE_CHANGED, buildProbeChangedEvent('created', probe));
      } catch (err) {
        this.logger.warn(`emit probe.changed (created) ล้มเหลว: ${(err as Error).message}`);
      }
      return probe.id;
    } catch (err) {
      // log จาก channel เดียวกันเข้ามาพร้อมกันหลายทาง (MQTT + RabbitMQ) ชน unique constraint ได้
      // อีกฝ่ายสร้างสำเร็จไปแล้ว จึงอ่านซ้ำแล้วใช้ของนั้น ไม่ใช่ error ที่ต้องโยนออกไป
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;

      const winner = await this.prisma.probes.findUnique({
        where: { deviceId_channel: { deviceId, channel } },
        select: { id: true },
      });
      if (!winner) throw err; // P2002 จาก constraint อื่น — ไม่ใช่ race ที่เราคิด
      return winner.id;
    }
  }
}
