import { Injectable, NotFoundException } from '@nestjs/common';
import { LogDays } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceService } from '../device/device.service';
import { RedisService } from '../redis/redis.service';
import { PartnerApiKeyContext } from './partner-api-key.service';

const TIMESERIES_WINDOW_MS = 60 * 60 * 1000; // 1 ชั่วโมง — คงที่ ไม่มีทาง query ช่วงอื่นแล้ว (ADR-0003)
const DEFAULT_WARD_LIST_LIMIT = 20;

export type HistoryRangeKey = 'DAY_1' | 'DAY_7' | 'DAY_30';

/**
 * single source of truth ของช่วงย้อนหลัง + ขนาด bucket — interval ถูก inline เป็น literal จาก map นี้เท่านั้น
 * (ไม่รับจาก client) จึงไม่มีช่องให้ inject ผ่าน raw query; ขนาด bucket คุมให้ response ไม่เกิน ~300 bucket/probe
 */
export const HISTORY_RANGES: Record<HistoryRangeKey, { days: number; bucket: string }> = {
  DAY_1: { days: 1, bucket: '15 minutes' },
  DAY_7: { days: 7, bucket: '1 hour' },
  DAY_30: { days: 30, bucket: '3 hours' },
};
const HISTORY_CACHE_TTL_SECONDS = 60;

export interface HistoryBucket {
  bucketStart: string;
  probe: string;
  tempAvg: number;
  tempMin: number;
  tempMax: number;
  humidityAvg: number;
  humidityMin: number;
  humidityMax: number;
  batteryMin: number;
  doorOpen: boolean;
  samples: number;
}

export interface DeviceHistory {
  device: PartnerDeviceMetadata;
  bucketInterval: string;
  buckets: HistoryBucket[];
}
const MAX_WARD_LIST_LIMIT = 100;
const DEFAULT_TELEMETRY_PAGE_LIMIT = 50;
const MAX_TELEMETRY_PAGE_LIMIT = 200;

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
    private readonly redis: RedisService,
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

  /** telemetry ย้อนหลัง 1/7/30 วัน แบบ downsample (avg/min/max ต่อ bucket ต่อ probe) — ไม่ส่ง raw row */
  async getDeviceHistory(
    apiKey: PartnerApiKeyContext,
    serial: string,
    range: HistoryRangeKey,
  ): Promise<DeviceHistory> {
    const device = await this.deviceService.findOne(serial);
    this.assertWardAllowed(apiKey, device.ward);

    const { days, bucket } = HISTORY_RANGES[range];
    // bind cutoff ที่คำนวณจาก JS ไม่ใช้ NOW() ใน SQL — clock ของ DB server เคยเพี้ยนไป 7 ชม. จากเครื่องแอป
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const buckets = await this.redis.getOrSet(
      `partner:history:${serial}:${range}`,
      HISTORY_CACHE_TTL_SECONDS,
      async () => {
        const rows = await this.prisma.$queryRawUnsafe<
          {
            bucket_start: Date;
            probe: string;
            temp_avg: number;
            temp_min: number;
            temp_max: number;
            humidity_avg: number;
            humidity_min: number;
            humidity_max: number;
            battery_min: number;
            door_open: boolean;
            samples: number;
          }[]
        >(
          `SELECT time_bucket('${bucket}', "send_time") AS bucket_start,
                  "probe",
                  AVG("temp")::float8 AS temp_avg, MIN("temp")::float8 AS temp_min, MAX("temp")::float8 AS temp_max,
                  AVG("humidity")::float8 AS humidity_avg, MIN("humidity")::float8 AS humidity_min, MAX("humidity")::float8 AS humidity_max,
                  MIN("battery")::int AS battery_min,
                  BOOL_OR("door1" OR "door2" OR "door3") AS door_open,
                  COUNT(*)::int AS samples
           FROM "log_days"
           WHERE "serial" = $1 AND "send_time" >= $2
           GROUP BY bucket_start, "probe"
           ORDER BY bucket_start ASC, "probe" ASC`,
          serial,
          from,
        );
        return rows.map((r) => ({
          bucketStart: r.bucket_start.toISOString(),
          probe: r.probe,
          tempAvg: r.temp_avg,
          tempMin: r.temp_min,
          tempMax: r.temp_max,
          humidityAvg: r.humidity_avg,
          humidityMin: r.humidity_min,
          humidityMax: r.humidity_max,
          batteryMin: r.battery_min,
          doorOpen: r.door_open,
          samples: r.samples,
        }));
      },
    );

    return { device: { ...toMetadata(device), serial }, bucketInterval: bucket, buckets };
  }

  /** raw row ย้อนหลัง 1/7/30 วัน เรียงใหม่→เก่า แบ่งหน้า — ไว้ทำตาราง (กราฟใช้ getDeviceHistory) */
  async listDeviceTelemetry(
    apiKey: PartnerApiKeyContext,
    serial: string,
    range: HistoryRangeKey,
    pagination: { page?: number; limit?: number },
  ): Promise<{
    device: PartnerDeviceMetadata;
    points: PartnerTelemetryPoint[];
    total: number;
    page: number;
    limit: number;
  }> {
    const device = await this.deviceService.findOne(serial);
    this.assertWardAllowed(apiKey, device.ward);

    const page = pagination.page && pagination.page > 0 ? pagination.page : 1;
    const limit = Math.min(
      pagination.limit && pagination.limit > 0 ? pagination.limit : DEFAULT_TELEMETRY_PAGE_LIMIT,
      MAX_TELEMETRY_PAGE_LIMIT,
    );
    // bind cutoff จาก JS ไม่ใช้ NOW() — เหตุผลเดียวกับ getDeviceHistory (clock ของ DB เพี้ยนได้)
    const from = new Date(Date.now() - HISTORY_RANGES[range].days * 24 * 60 * 60 * 1000);
    const where = { serial, sendTime: { gte: from } };

    const [rows, total] = await Promise.all([
      this.prisma.logDays.findMany({
        where,
        // id เป็น tiebreaker — หลาย probe/แถวมี sendTime เดียวกันได้ ถ้าไม่มีหน้าจะซ้ำ/ตกหล่น
        orderBy: [{ sendTime: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.logDays.count({ where }),
    ]);

    return {
      device: { ...toMetadata(device), serial },
      points: rows.map(toTelemetryPoint),
      total,
      page,
      limit,
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
