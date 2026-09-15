import { Injectable, NotFoundException } from '@nestjs/common';
import { LogDays } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceService } from '../device/device.service';
import { PartnerApiKeyContext } from './partner-api-key.service';

const TIMESERIES_WINDOW_MS = 60 * 60 * 1000; // 1 ชั่วโมง — คงที่ ไม่มีทาง query ช่วงอื่นแล้ว (ADR-0003)
const DEFAULT_WARD_LIST_LIMIT = 20;
const MAX_WARD_LIST_LIMIT = 100;

export interface PartnerDeviceMetadata {
  serial: string;
  name: string | null;
  status: boolean;
  firmware: string | null;
  online: boolean;
}

export interface PartnerTelemetryPoint {
  sendTime: Date;
  temp: number;
  tempDisplay: number;
  humidity: number;
  humidityDisplay: number;
  tempInternal: number | null;
  battery: number;
  plug: boolean;
  door1: boolean;
  door2: boolean;
  door3: boolean;
  internet: boolean;
  extMemory: boolean;
  probe: string;
}

export interface DeviceWithLatestReading {
  device: PartnerDeviceMetadata;
  latest: PartnerTelemetryPoint | null;
}

export interface ListDevicesByWardResult {
  devices: DeviceWithLatestReading[];
  total: number;
  page: number;
  limit: number;
}

const WITH_HARDWARE = { hardware: true } as const;

function toMetadata(device: {
  serial: string | null;
  name: string | null;
  status: boolean;
  online: boolean;
  hardware?: { firmware?: string } | null;
}): PartnerDeviceMetadata {
  return {
    serial: device.serial ?? '',
    name: device.name,
    status: device.status,
    firmware: device.hardware?.firmware ?? null,
    online: device.online,
  };
}

function toTelemetryPoint(log: LogDays): PartnerTelemetryPoint {
  return {
    sendTime: log.sendTime,
    temp: log.temp,
    tempDisplay: log.tempDisplay,
    humidity: log.humidity,
    humidityDisplay: log.humidityDisplay,
    tempInternal: log.tempInternal,
    battery: log.battery,
    plug: log.plug,
    door1: log.door1,
    door2: log.door2,
    door3: log.door3,
    internet: log.internet,
    extMemory: log.extMemory,
    probe: log.probe,
  };
}

@Injectable()
export class PartnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deviceService: DeviceService,
  ) {}

  /**
   * ward ที่ key ไม่ได้รับสิทธิ์ต้องตอบ 404 ไม่ใช่ 403 — ไม่ยืนยันว่า ward/serial นั้นมีอยู่จริง
   * ต่อผู้เรียกที่ไม่ได้รับอนุญาต (กัน enumeration) เหมือนพฤติกรรมเดิมตอน scope ด้วย serial
   */
  private assertWardAllowed(apiKey: PartnerApiKeyContext, ward: string): void {
    if (!apiKey.wards.has(ward)) {
      throw new NotFoundException(`Ward ${ward} not found`);
    }
  }

  /** metadata + timeseries ย้อนหลัง 1 ชั่วโมงคงที่ (ไม่มี from/to แบบเดิมอีกแล้ว — ดู ADR-0003) */
  async getDeviceSnapshot(
    apiKey: PartnerApiKeyContext,
    serial: string,
  ): Promise<{ device: PartnerDeviceMetadata; timeseries: PartnerTelemetryPoint[] }> {
    // ต้อง resolve device ก่อนเพื่อรู้ ward ของมัน แล้วค่อยเช็คสิทธิ์ — ต่างจาก serial-allowlist
    // เดิมที่เช็คก่อน query ได้เลยเพราะ scope ด้วย serial ตรง ๆ
    const device = await this.deviceService.findOne(serial);
    this.assertWardAllowed(apiKey, device.ward);

    const from = new Date(Date.now() - TIMESERIES_WINDOW_MS);
    const logs = await this.prisma.logDays.findMany({
      where: { serial, sendTime: { gte: from } },
      orderBy: { sendTime: 'desc' },
    });

    return {
      // serial ต้องตรงกับ input เป๊ะ (ไม่ใช่ device.serial ที่ nullable) — เหมือนพฤติกรรมเดิมตอนเป็น REST
      device: { ...toMetadata(device), serial },
      timeseries: logs.map(toTelemetryPoint),
    };
  }

  /** ทุก device ใน ward + reading ล่าสุดของแต่ละตัว (ไม่ใช่ full 1h series — เก็บไว้ที่ getDeviceSnapshot เท่านั้น) */
  async listDevicesByWard(
    apiKey: PartnerApiKeyContext,
    ward: string,
    pagination: { page?: number; limit?: number },
  ): Promise<ListDevicesByWardResult> {
    this.assertWardAllowed(apiKey, ward);

    const page = pagination.page && pagination.page > 0 ? pagination.page : 1;
    const limit = Math.min(
      pagination.limit && pagination.limit > 0 ? pagination.limit : DEFAULT_WARD_LIST_LIMIT,
      MAX_WARD_LIST_LIMIT,
    );

    const [rows, total] = await Promise.all([
      this.prisma.devices.findMany({
        where: { ward },
        include: WITH_HARDWARE,
        orderBy: { seq: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.devices.count({ where: { ward } }),
    ]);

    // N+1 ตั้งใจ — ขนาด list ถูก cap ด้วย limit (สูงสุด 100) จึงไม่คุ้มที่จะเขียน query
    // window function ให้ซับซ้อนขึ้นตอนนี้
    const devices = await Promise.all(
      rows.map(async (device) => {
        const latest = device.serial
          ? await this.prisma.logDays.findFirst({
              where: { serial: device.serial },
              orderBy: { sendTime: 'desc' },
            })
          : null;
        return {
          device: toMetadata(device),
          latest: latest ? toTelemetryPoint(latest) : null,
        };
      }),
    );

    return { devices, total, page, limit };
  }

  /** audit log — เขียนแบบ best-effort ไม่ block/พัง response ของ RPC จริง */
  async logRequest(
    keyId: string,
    identifiers: { serial?: string | null; ward?: string | null },
    path: string,
    statusCode: number,
  ): Promise<void> {
    await this.prisma.partnerApiRequestLogs.create({
      data: {
        keyId,
        serial: identifiers.serial ?? null,
        ward: identifiers.ward ?? null,
        path,
        statusCode,
      },
    });
  }
}
