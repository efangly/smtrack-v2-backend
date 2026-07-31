import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Firmwares } from '../generated/prisma/client';
import { AppEvents } from '../common/events/app-events';
import {
  FirmwareChangeAction,
  buildFirmwareChangedEvent,
} from '../common/events/firmware-changed.event';
import { DeviceChangeActor } from '../common/events/device-changed.event';
import { PrismaService } from '../prisma/prisma.service';
import { FirmwareStorageService } from './firmware-storage.service';
import { CreateFirmwareDto } from './dto/create-firmware.dto';
import { UpdateFirmwareDto } from './dto/update-firmware.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';
import { paginationSkip, toPaginated } from '../common/pagination/paginate.util';

@Injectable()
export class FirmwareService {
  private readonly logger = new Logger(FirmwareService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FirmwareStorageService,
    private readonly events: EventEmitter2,
  ) {}

  private emitChanged(
    action: FirmwareChangeAction,
    firmware: Firmwares,
    actor?: DeviceChangeActor,
  ): void {
    try {
      this.events.emit(
        AppEvents.FIRMWARE_CHANGED,
        buildFirmwareChangedEvent(action, firmware, actor),
      );
    } catch (err) {
      this.logger.warn(`emit firmware.changed (${action}) ล้มเหลว: ${(err as Error).message}`);
    }
  }

  private uploadFile(file: Express.Multer.File): Promise<string> {
    const key = `firmware/${randomUUID()}${extname(file.originalname)}`;
    return this.storage.upload(key, file.buffer, file.mimetype);
  }

  async create(
    dto: CreateFirmwareDto,
    file: Express.Multer.File,
    actor?: DeviceChangeActor,
  ): Promise<Firmwares> {
    const fileKey = await this.uploadFile(file);

    try {
      const firmware = await this.prisma.firmwares.create({
        data: {
          ...dto,
          fileKey,
          fileName: file.originalname,
          fileSize: file.size,
        },
      });
      this.emitChanged('created', firmware, actor);
      return firmware;
    } catch (err) {
      await this.storage.delete(fileKey);
      throw err;
    }
  }

  async findAll(pagination: PaginationQueryDto): Promise<Paginated<Firmwares>> {
    const [data, total] = await Promise.all([
      this.prisma.firmwares.findMany({
        orderBy: { createAt: 'desc' },
        skip: paginationSkip(pagination),
        take: pagination.limit ?? 20,
      }),
      this.prisma.firmwares.count(),
    ]);
    return toPaginated(data, total, pagination);
  }

  async findOne(id: string): Promise<Firmwares> {
    const firmware = await this.prisma.firmwares.findUnique({ where: { id } });
    if (!firmware) {
      throw new NotFoundException(`Firmware ${id} not found`);
    }
    return firmware;
  }

  /** ล่าสุดตามเวลาที่อัปโหลด — ให้อุปกรณ์เทียบกับ Hardware.firmware ปัจจุบันก่อนตัดสินใจดาวน์โหลด */
  async findLatest(): Promise<Firmwares> {
    const firmware = await this.prisma.firmwares.findFirst({ orderBy: { createAt: 'desc' } });
    if (!firmware) {
      throw new NotFoundException('No firmware available');
    }
    return firmware;
  }

  async findByVersion(version: string): Promise<Firmwares> {
    const firmware = await this.prisma.firmwares.findUnique({ where: { version } });
    if (!firmware) {
      throw new NotFoundException(`Firmware ${version} not found`);
    }
    return firmware;
  }

  getStream(firmware: Firmwares): Promise<Readable> {
    return this.storage.getStream(firmware.fileKey);
  }

  // version ระบุตัวตนของเวอร์ชั่นนั้นตั้งแต่สร้าง ไม่ให้แก้ย้อนหลัง (ต้องการเวอร์ชั่นใหม่ต้องอัปโหลดรายการใหม่)
  async update(
    id: string,
    dto: UpdateFirmwareDto,
    file: Express.Multer.File | undefined,
    actor?: DeviceChangeActor,
  ): Promise<Firmwares> {
    const { version: _unusedVersion, ...fields } = dto;
    void _unusedVersion;

    let previousFileKey: string | null = null;
    let fileFields: { fileKey: string; fileName: string; fileSize: number } | undefined;
    if (file) {
      previousFileKey = (await this.findOne(id)).fileKey;
      const fileKey = await this.uploadFile(file);
      fileFields = { fileKey, fileName: file.originalname, fileSize: file.size };
    }

    let firmware: Firmwares;
    try {
      firmware = await this.prisma.firmwares.update({
        where: { id },
        data: { ...fields, ...(fileFields ?? {}) },
      });
    } catch (err) {
      if (fileFields) await this.storage.delete(fileFields.fileKey);
      throw err;
    }

    if (previousFileKey) {
      await this.storage.delete(previousFileKey);
    }

    this.emitChanged('updated', firmware, actor);
    return firmware;
  }

  async remove(id: string, actor?: DeviceChangeActor): Promise<Firmwares> {
    const firmware = await this.prisma.firmwares.delete({ where: { id } });
    await this.storage.delete(firmware.fileKey);
    this.emitChanged('deleted', firmware, actor);
    return firmware;
  }
}
