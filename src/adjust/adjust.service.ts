import { Injectable } from '@nestjs/common';
import { Configs, Devices, Probes } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceService } from '../device/device.service';
import { ProbeService } from '../probe/probe.service';
import { ProbeResolverService } from '../probe/probe-resolver.service';
import { DeviceConfigService } from '../device-config/device-config.service';
import { UpdateProbeDto } from '../probe/dto/update-probe.dto';
import { UpdateDeviceConfigDto } from '../device-config/dto/update-device-config.dto';
import { UpdateAdjustDeviceDto } from './dto/update-adjust-device.dto';

export interface AdjustSnapshot {
  device: Devices;
  config: Configs | null;
  probe: Probes[];
}

/**
 * Business logic ของ endpoint ไม่มี auth สำหรับอุปกรณ์ IoT อ่าน/แก้ค่าตั้งค่าตัวเอง
 *
 * reuse service ของ CRUD ฝั่ง admin ทั้งหมด (DeviceService/ProbeService/DeviceConfigService)
 * เพื่อไม่ให้ logic การ cache-invalidate/emit event ซ้ำกันสองที่ — โมดูลนี้ทำหน้าที่แค่ resolve
 * serial -> deviceId แล้วส่งต่อ
 */
@Injectable()
export class AdjustService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deviceService: DeviceService,
    private readonly probeService: ProbeService,
    private readonly probeResolver: ProbeResolverService,
    private readonly configService: DeviceConfigService,
  ) {}

  async getSnapshot(serial: string): Promise<AdjustSnapshot> {
    const device = await this.deviceService.findOne(serial);
    const [config, probe] = await Promise.all([
      this.prisma.configs.findUnique({ where: { deviceId: device.id } }),
      this.prisma.probes.findMany({ where: { deviceId: device.id }, orderBy: { channel: 'asc' } }),
    ]);
    return { device, config, probe };
  }

  async updateProbe(serial: string, channel: string, dto: UpdateProbeDto): Promise<Probes> {
    const device = await this.deviceService.findOne(serial);
    const probeId = await this.probeResolver.resolveProbeId(device.id, channel);
    return this.probeService.update(probeId, dto);
  }

  async updateConfig(serial: string, dto: UpdateDeviceConfigDto): Promise<Configs> {
    const device = await this.deviceService.findOne(serial);
    // config ที่ไม่มีอยู่จริงจะโดน Prisma P2025 -> global HttpExceptionFilter แปลงเป็น 404 เอง
    return this.configService.update(device.id, dto);
  }

  async updateDevice(serial: string, dto: UpdateAdjustDeviceDto): Promise<Devices> {
    return this.deviceService.update(serial, dto);
  }
}
