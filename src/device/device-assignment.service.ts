import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DeviceAssignments, Devices } from '../generated/prisma/client';
import { AppEvents } from '../common/events/app-events';
import { DeviceChangeActor, buildDeviceChangedEvent } from '../common/events/device-changed.event';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** cache ของ serial → deviceId ที่ ingest ใช้ทุกแถว จึงต้องสั้นและถูก invalidate ตอน swap เสมอ */
const RESOLVE_TTL = 300;
const resolveKey = (serial: string) => `assign:${serial}`;
const wardKey = (serial: string) => `ward:${serial}`;

export interface SwapResult {
  device: Devices;
  previousSerial: string | null;
  assignment: DeviceAssignments;
}

/**
 * จัดการความสัมพันธ์ "กล่องไหนติดตั้งอยู่จุดไหน" ทั้งการอ่าน (resolve) และการเขียน (swap/install)
 *
 * เป็นจุดเดียวที่ได้รับอนุญาตให้เขียน `Devices.serial` เพราะค่านั้นเป็น denormalized pointer
 * ของ assignment ที่ยังเปิดอยู่ ถ้าเขียนจากที่อื่นทั้งสองฝั่งจะหลุด sync กันได้
 */
@Injectable()
export class DeviceAssignmentService {
  private readonly logger = new Logger(DeviceAssignmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * หา deviceId ของจุดติดตั้งที่กล่อง `serial` ติดตั้งอยู่ ณ ตอนนี้
   * คืน null ถ้ากล่องยังไม่ถูกติดตั้งที่ไหน (เพิ่งซ่อมเสร็จ/อยู่ในคลัง) — ไม่ throw
   *
   * JSON.stringify(null) เก็บลง Redis ได้ จึง cache กรณี "ไม่มี" ได้ด้วย ไม่ยิง DB ซ้ำ
   */
  resolveDeviceId(serial: string): Promise<string | null> {
    return this.redis.getOrSet(resolveKey(serial), RESOLVE_TTL, async () => {
      const device = await this.prisma.devices.findUnique({
        where: { serial },
        select: { id: true },
      });
      return device?.id ?? null;
    });
  }

  /**
   * หา ward ของจุดติดตั้งที่กล่อง `serial` ติดตั้งอยู่ ณ ตอนนี้ — ใช้กรอง SSE ตาม ward ของผู้ใช้
   * คืน null ถ้ากล่องยังไม่ถูกติดตั้งที่ไหน (event นั้นจะเห็นได้เฉพาะ role ที่ไม่ถูก scope)
   */
  resolveWard(serial: string): Promise<string | null> {
    return this.redis.getOrSet(wardKey(serial), RESOLVE_TTL, async () => {
      const device = await this.prisma.devices.findUnique({
        where: { serial },
        select: { ward: true },
      });
      return device?.ward ?? null;
    });
  }

  /**
   * ติดตั้งกล่องลงจุดติดตั้ง — ปิด assignment เดิม (ทั้งของจุดนี้และของกล่องนี้) แล้วเปิดอันใหม่
   *
   * ทำในทรานแซกชันเดียวกับการอัปเดต `Devices.serial` เพื่อไม่ให้ pointer กับ assignment หลุด sync
   * ปิด assignment ของกล่องที่จุดอื่นด้วย เพื่อรองรับเคสกล่องที่ซ่อมเสร็จแล้วย้ายมาจุดใหม่
   * (ถ้าไม่ปิด partial unique index `device_assignments_active_serial` จะกันไว้เอง)
   */
  async assign(
    deviceId: string,
    serial: string,
    reason?: string,
    actor?: DeviceChangeActor,
  ): Promise<SwapResult> {
    const result = await this.prisma.$transaction(async (tx) => {
      const device = await tx.devices.findUnique({ where: { id: deviceId } });
      if (!device) throw new NotFoundException(`Device ${deviceId} not found`);

      const previousSerial = device.serial;
      if (previousSerial === serial) {
        const current = await tx.deviceAssignments.findFirstOrThrow({
          where: { deviceId, serial, endedAt: null },
        });
        return { device, previousSerial, assignment: current };
      }

      // กล่องต้องมีอยู่จริงก่อน — ยังไม่เคยเห็นก็สร้างให้ (เคสกล่องใหม่แกะกล่อง)
      await tx.hardware.upsert({
        where: { serial },
        update: {},
        create: { serial },
      });

      const endedAt = new Date();
      // ปิด assignment ที่เปิดอยู่ของ "จุดติดตั้งนี้" (กล่องเก่าถูกถอดออก)
      await tx.deviceAssignments.updateMany({
        where: { deviceId, endedAt: null },
        data: { endedAt },
      });
      // และของ "กล่องนี้" ที่อาจยังค้างอยู่ที่จุดอื่น (กล่องถูกย้ายมา)
      await tx.deviceAssignments.updateMany({
        where: { serial, endedAt: null },
        data: { endedAt },
      });
      // จุดติดตั้งเดิมของกล่องนี้ต้องไม่ชี้มาที่มันอีก ไม่งั้น unique ของ devices.serial จะชน
      await tx.devices.updateMany({
        where: { serial, id: { not: deviceId } },
        data: { serial: null },
      });

      const assignment = await tx.deviceAssignments.create({
        data: { deviceId, serial, startedAt: endedAt, reason },
      });
      const updated = await tx.devices.update({
        where: { id: deviceId },
        data: { serial },
        include: { hardware: true },
      });

      return { device: updated, previousSerial, assignment };
    });

    await this.invalidate(result.previousSerial, serial);
    this.logger.log(
      `assigned ${serial} to device ${deviceId}` +
        (result.previousSerial ? ` (replacing ${result.previousSerial})` : ''),
    );

    // เท่ากันแปลว่าไม่มีอะไรเปลี่ยน (เส้นทาง no-op ด้านบน) ไม่ต้องกวน client
    if (result.previousSerial !== serial) {
      this.emitChanged(result.device, result.previousSerial, actor);
    }
    return result;
  }

  /** push การสลับกล่องเข้า sse — ห้ามให้ listener ที่พังทำให้ swap ที่ commit ไปแล้วโยน error */
  private emitChanged(
    device: Devices,
    previousSerial: string | null,
    actor?: DeviceChangeActor,
  ): void {
    try {
      this.events.emit(
        AppEvents.DEVICE_CHANGED,
        buildDeviceChangedEvent('swapped', device, previousSerial, actor),
      );
    } catch (err) {
      this.logger.warn(`emit device.changed (swapped) ล้มเหลว: ${(err as Error).message}`);
    }
  }

  /** สลับเครื่องโดยอ้างจุดติดตั้งด้วย staticName ซึ่งเป็น identity ถาวรที่หน้างานใช้จริง */
  async swapByStaticName(
    staticName: string,
    serial: string,
    reason?: string,
    actor?: DeviceChangeActor,
  ): Promise<SwapResult> {
    const device = await this.prisma.devices.findUnique({
      where: { staticName },
      select: { id: true },
    });
    if (!device) throw new NotFoundException(`Device ${staticName} not found`);
    return this.assign(device.id, serial, reason, actor);
  }

  /**
   * แปลง path param ที่ client ส่งมาเป็น deviceId
   *
   * รับได้ทั้ง serial ของกล่องที่ติดตั้งอยู่ (พฤติกรรมเดิมของ API) และ staticName ของจุดติดตั้ง
   * — อย่างหลังใช้ได้แม้จุดนั้นกำลังไม่มีกล่องติดตั้งอยู่ (เช่น ถอดไปซ่อมและยังไม่มีตัวแทน)
   */
  async resolveDeviceIdOrThrow(serialOrStaticName: string): Promise<string> {
    const device = await this.prisma.devices.findFirst({
      where: {
        OR: [{ serial: serialOrStaticName }, { staticName: serialOrStaticName }],
      },
      select: { id: true },
    });
    if (!device) throw new NotFoundException(`Device ${serialOrStaticName} not found`);
    return device.id;
  }

  /** ประวัติการติดตั้งของจุดติดตั้ง เรียงจากใหม่ไปเก่า */
  history(deviceId: string): Promise<DeviceAssignments[]> {
    return this.prisma.deviceAssignments.findMany({
      where: { deviceId },
      orderBy: { startedAt: 'desc' },
    });
  }

  /**
   * ล้าง cache ของ serial ที่เกี่ยวข้อง — พลาดตรงนี้แล้ว ingest จะประทับ deviceId เก่า
   * ต่อไปอีกจนกว่า TTL จะหมด ซึ่งเป็นบั๊กที่หาเจอยากที่สุดของดีไซน์นี้
   */
  async invalidate(...serials: (string | null | undefined)[]): Promise<void> {
    await Promise.all(
      serials
        .filter((s): s is string => !!s)
        .flatMap((s) => [this.redis.del(resolveKey(s)), this.redis.del(wardKey(s))]),
    );
  }
}
