import { Injectable, NotFoundException } from '@nestjs/common';
import { Devices } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreateDeviceDto } from './dto/create-device.dto';

const ALL_KEY = 'device:all';
const oneKey = (serial: string) => `device:${serial}`;

@Injectable()
export class DeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  create(dto: CreateDeviceDto): Promise<Devices> {
    return this.prisma.devices.create({ data: dto });
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
}
