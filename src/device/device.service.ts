import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Devices } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { DeviceImageStorageService } from './device-image-storage.service';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';

const ALL_KEY = 'device:all';
const oneKey = (serial: string) => `device:${serial}`;

@Injectable()
export class DeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly imageStorage: DeviceImageStorageService,
  ) {}

  async create(dto: CreateDeviceDto, file?: Express.Multer.File): Promise<Devices> {
    const positionPic = file ? await this.uploadImage(dto.serial, file) : undefined;
    try {
      return await this.prisma.devices.create({ data: { ...dto, positionPic } });
    } catch (err) {
      if (positionPic) await this.imageStorage.delete(positionPic);
      throw err;
    }
  }

  private uploadImage(serial: string, file: Express.Multer.File): Promise<string> {
    const key = `devices/${randomUUID()}${extname(file.originalname)}`;
    return this.imageStorage.upload(key, file.buffer, file.mimetype);
  }

  findAll(): Promise<Devices[]> {
    return this.redis.getOrSet(ALL_KEY, 300, () =>
      this.prisma.devices.findMany({ orderBy: { seq: 'asc' } }),
    );
  }

  findOne(serial: string): Promise<Devices> {
    return this.redis.getOrSet(oneKey(serial), 300, async () => {
      const device = await this.prisma.devices.findUnique({ where: { serial } });
      if (!device) {
        throw new NotFoundException(`Device ${serial} not found`);
      }
      return device;
    });
  }

  /** อัปเดตสถานะ online/offline (เรียกจาก status topic handler / heartbeat) */
  async setOnline(serial: string, online: boolean): Promise<Devices> {
    const device = await this.prisma.devices.update({ where: { serial }, data: { online } });
    await this.redis.del(oneKey(serial));
    await this.redis.del(ALL_KEY);
    return device;
  }

  async update(serial: string, dto: UpdateDeviceDto, file?: Express.Multer.File): Promise<Devices> {
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
      device = await this.prisma.devices.update({
        where: { serial },
        data: { ...dto, ...(positionPic ? { positionPic } : {}) },
      });
    } catch (err) {
      if (positionPic) await this.imageStorage.delete(positionPic);
      throw err;
    }

    await this.redis.del(oneKey(serial));
    await this.redis.del(ALL_KEY);

    if (previousPositionPic) {
      await this.imageStorage.delete(previousPositionPic);
    }

    return device;
  }
}
