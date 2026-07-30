import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Devices } from '../generated/prisma/client';
import { AppEvents } from '../common/events/app-events';
import {
  DeviceChangeAction,
  DeviceChangeActor,
  buildDeviceChangedEvent,
} from '../common/events/device-changed.event';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { DeviceAssignmentService } from './device-assignment.service';
import { DeviceImageStorageService } from './device-image-storage.service';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';
import { paginationSkip, toPaginated } from '../common/pagination/paginate.util';

const ALL_KEY_PREFIX = 'device:all';
const allKey = (pagination: PaginationQueryDto) =>
  `${ALL_KEY_PREFIX}:${pagination.page ?? 1}:${pagination.limit ?? 20}`;
const oneKey = (serial: string) => `device:${serial}`;

/** include กล่องที่ติดตั้งอยู่ปัจจุบันเสมอ เพื่อให้ client ยังเห็น firmware/token เหมือนก่อนแยกตาราง */
const WITH_HARDWARE = { hardware: true } as const;

@Injectable()
export class DeviceService {
  private readonly logger = new Logger(DeviceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly imageStorage: DeviceImageStorageService,
    private readonly assignments: DeviceAssignmentService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * แจ้ง sse (และ consumer อื่นในโปรเซส) ว่าจุดติดตั้งนี้เปลี่ยน
   *
   * EventEmitter2 เรียก listener แบบ sync — ถ้า listener โยน error มันจะเด้งกลับมาที่ caller
   * จึงต้องกลืนไว้ตรงนี้ ไม่ให้ push realtime พังแล้วทำให้ mutation ที่ commit ไปแล้วพังตาม
   */
  private emitChanged(
    action: DeviceChangeAction,
    device: Devices,
    actor?: DeviceChangeActor,
  ): void {
    try {
      this.events.emit(
        AppEvents.DEVICE_CHANGED,
        buildDeviceChangedEvent(action, device, undefined, actor),
      );
    } catch (err) {
      this.logger.warn(`emit device.changed (${action}) ล้มเหลว: ${(err as Error).message}`);
    }
  }

  /**
   * สร้างจุดติดตั้งใหม่ — ถ้าระบุ serial มาด้วยจะสร้าง/ผูกกล่องและเปิด assignment ให้ในตัว
   *
   * `firmware`/`token`/`installDate` เป็นคุณสมบัติของกล่อง ไม่ใช่ของจุดติดตั้ง จึงถูกแยกออกจาก dto
   * ไปเขียนลงตาราง hardware แทน (API ภายนอกยังรับหน้าตาเดิม)
   */
  async create(
    dto: CreateDeviceDto,
    file?: Express.Multer.File,
    actor?: DeviceChangeActor,
  ): Promise<Devices> {
    const { serial, firmware, installDate, ...deviceFields } = dto;
    const positionPic = file ? await this.uploadImage(serial, file) : undefined;

    try {
      const device = await this.prisma.$transaction(async (tx) => {
        const created = await tx.devices.create({
          data: { ...deviceFields, positionPic },
          include: WITH_HARDWARE,
        });
        if (!serial) return created;

        await tx.hardware.upsert({
          where: { serial },
          update: { firmware, installDate },
          create: { serial, firmware, installDate },
        });
        await tx.deviceAssignments.create({
          data: { deviceId: created.id, serial, reason: 'created' },
        });
        return tx.devices.update({
          where: { id: created.id },
          data: { serial },
          include: WITH_HARDWARE,
        });
      });

      await this.assignments.invalidate(serial);
      await this.redis.delByPattern(`${ALL_KEY_PREFIX}:*`);
      this.emitChanged('created', device, actor);
      return device;
    } catch (err) {
      if (positionPic) await this.imageStorage.delete(positionPic);
      throw err;
    }
  }

  private uploadImage(serial: string, file: Express.Multer.File): Promise<string> {
    const key = `devices/${randomUUID()}${extname(file.originalname)}`;
    return this.imageStorage.upload(key, file.buffer, file.mimetype);
  }

  async findAll(pagination: PaginationQueryDto): Promise<Paginated<Devices>> {
    // เก็บ cache เป็น {data, total} ธรรมดา ไม่ใช่ instance ของ Paginated เพราะ getOrSet
    // เขียน/อ่านผ่าน JSON.stringify/parse ทำให้ instanceof เช็คไม่ผ่านตอน cache hit
    const { data, total } = await this.redis.getOrSet(allKey(pagination), 300, async () => {
      const [data, total] = await Promise.all([
        this.prisma.devices.findMany({
          include: WITH_HARDWARE,
          orderBy: { seq: 'asc' },
          skip: paginationSkip(pagination),
          take: pagination.limit ?? 20,
        }),
        this.prisma.devices.count(),
      ]);
      return { data, total };
    });
    return toPaginated(data, total, pagination);
  }

  /** หาด้วย serial ของกล่องที่ติดตั้งอยู่ปัจจุบัน (พฤติกรรมเดิมของ GET /devices/:serial) */
  findOne(serial: string): Promise<Devices> {
    return this.redis.getOrSet(oneKey(serial), 300, async () => {
      const device = await this.prisma.devices.findUnique({
        where: { serial },
        include: WITH_HARDWARE,
      });
      if (!device) {
        throw new NotFoundException(`Device ${serial} not found`);
      }
      return device;
    });
  }

  /** หาด้วย identity ถาวรของจุดติดตั้ง — ใช้ได้แม้ยังไม่มีกล่องติดตั้งอยู่ */
  async findByStaticName(staticName: string): Promise<Devices> {
    const device = await this.prisma.devices.findUnique({
      where: { staticName },
      include: WITH_HARDWARE,
    });
    if (!device) {
      throw new NotFoundException(`Device ${staticName} not found`);
    }
    return device;
  }

  /**
   * อัปเดตสถานะ online/offline (เรียกจาก status topic handler / heartbeat)
   *
   * emit เฉพาะตอนค่าเปลี่ยนจริง — heartbeat ส่งซ้ำสถานะเดิมได้เรื่อย ๆ ถ้า emit ทุกครั้ง
   * client ที่เปิด stream ค้างจะโดนสแปม event ที่ไม่มีอะไรเปลี่ยน
   */
  async setOnline(serial: string, online: boolean): Promise<Devices> {
    const previous = await this.prisma.devices.findUnique({
      where: { serial },
      select: { online: true },
    });
    const device = await this.prisma.devices.update({
      where: { serial },
      data: { online },
      include: WITH_HARDWARE,
    });
    await this.redis.del(oneKey(serial));
    await this.redis.delByPattern(`${ALL_KEY_PREFIX}:*`);

    if (previous?.online !== online) {
      this.emitChanged(online ? 'online' : 'offline', device);
    }
    return device;
  }

  /**
   * อัปเดตข้อมูลจุดติดตั้ง
   *
   * `serial` ถูกตัดออกจาก dto โดยตั้งใจ — การเปลี่ยนกล่องต้องผ่าน DeviceAssignmentService.swap
   * เท่านั้น ไม่งั้น pointer จะเปลี่ยนโดยไม่มี assignment รองรับ และประวัติจะขาด
   * ส่วน `firmware`/`installDate` เป็นของกล่อง จึงเขียนลง hardware แทน
   */
  async update(
    serial: string,
    dto: UpdateDeviceDto,
    file?: Express.Multer.File,
    actor?: DeviceChangeActor,
  ): Promise<Devices> {
    const { serial: _unusedSerial, firmware, installDate, ...deviceFields } = dto;
    void _unusedSerial;

    let previousPositionPic: string | null = null;
    let positionPic: string | undefined;
    if (file) {
      previousPositionPic =
        (await this.prisma.devices.findUnique({ where: { serial }, select: { positionPic: true } }))
          ?.positionPic ?? null;
      positionPic = await this.uploadImage(serial, file);
    }

    let device: Devices;
    try {
      device = await this.prisma.$transaction(async (tx) => {
        if (firmware !== undefined || installDate !== undefined) {
          await tx.hardware.update({ where: { serial }, data: { firmware, installDate } });
        }
        return tx.devices.update({
          where: { serial },
          data: { ...deviceFields, ...(positionPic ? { positionPic } : {}) },
          include: WITH_HARDWARE,
        });
      });
    } catch (err) {
      if (positionPic) await this.imageStorage.delete(positionPic);
      throw err;
    }

    await this.redis.del(oneKey(serial));
    await this.redis.delByPattern(`${ALL_KEY_PREFIX}:*`);
    // ward เปลี่ยนได้จาก dto นี้ — ต้องล้าง cache serial→ward ที่ SSE ใช้กรอง ไม่งั้น
    // client ward เดิมจะยังเห็น event ของเครื่องที่ย้ายออกไปแล้วจนกว่า TTL จะหมด
    await this.assignments.invalidate(serial);

    if (previousPositionPic) {
      await this.imageStorage.delete(previousPositionPic);
    }

    this.emitChanged('updated', device, actor);
    return device;
  }
}
