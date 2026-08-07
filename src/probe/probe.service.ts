import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Probes } from '../generated/prisma/client';
import { AppEvents } from '../common/events/app-events';
import { ProbeChangeAction, buildProbeChangedEvent } from '../common/events/probe-changed.event';
import { DeviceChangeActor } from '../common/events/device-changed.event';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProbeDto } from './dto/create-probe.dto';
import { UpdateProbeDto } from './dto/update-probe.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';
import { paginationSkip, toPaginated } from '../common/pagination/paginate.util';

export interface ProbeTelemetrySnapshot {
  id: string;
  channel: string;
  name: string | null;
  type: string | null;
  doorQty: number;
  temp: number | null;
  tempDisplay: number | null;
  humidity: number | null;
  humidityDisplay: number | null;
  door1: boolean | null;
  door2: boolean | null;
  door3: boolean | null;
  sendTime: Date | null;
}

@Injectable()
export class ProbeService {
  private readonly logger = new Logger(ProbeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  private emitChanged(action: ProbeChangeAction, probe: Probes, actor?: DeviceChangeActor): void {
    try {
      this.events.emit(AppEvents.PROBE_CHANGED, buildProbeChangedEvent(action, probe, actor));
    } catch (err) {
      this.logger.warn(`emit probe.changed (${action}) ล้มเหลว: ${(err as Error).message}`);
    }
  }

  async create(deviceId: string, dto: CreateProbeDto, actor?: DeviceChangeActor): Promise<Probes> {
    // (deviceId, channel) unique แล้ว และทุก device มี probe channel '1' ติดมาตั้งแต่ถูกสร้าง
    // (device.service.ts สร้าง probe default ให้) ถ้าไม่ default channel ให้ POST ที่ไม่ส่ง channel
    // จะ 409 ทุกครั้งซึ่งไม่ใช่พฤติกรรมที่ผู้ใช้คาด — เดาช่องถัดไปให้แทน
    const channel = dto.channel ?? (await this.nextChannel(deviceId));
    const probe = await this.prisma.probes.create({ data: { ...dto, channel, deviceId } });
    this.emitChanged('created', probe, actor);
    return probe;
  }

  /**
   * ช่องว่างถัดไปของ device — นับจากเลข channel ที่มากสุดที่เป็นตัวเลข
   *
   * channel เป็น String (อุปกรณ์บางรุ่นส่งไม่ใช่ตัวเลข) จึงกรองเฉพาะที่เป็นตัวเลขมาคิด
   * ยังชนกันได้ถ้ามีสอง request พร้อมกัน — ปล่อยให้ P2002 → 409 ตอบไป ไม่ต้อง lock
   */
  private async nextChannel(deviceId: string): Promise<string> {
    const probes = await this.prisma.probes.findMany({
      where: { deviceId },
      select: { channel: true },
    });
    const highest = probes.reduce((max, { channel }) => {
      const n = Number(channel);
      return Number.isInteger(n) && n > max ? n : max;
    }, 0);
    return String(highest + 1);
  }

  async findAllByDevice(
    deviceId: string,
    pagination: PaginationQueryDto,
  ): Promise<Paginated<Probes>> {
    const [data, total] = await Promise.all([
      this.prisma.probes.findMany({
        where: { deviceId },
        skip: paginationSkip(pagination),
        take: pagination.limit ?? 20,
      }),
      this.prisma.probes.count({ where: { deviceId } }),
    ]);
    return toPaginated(data, total, pagination);
  }

  /**
   * ค่า telemetry ล่าสุด "ต่อ probe" ของ device — ต่างจาก findAllByDevice ที่คืนแค่ config
   * (doorQty/channel/...) ใช้สำหรับ device list ที่ต้องแยกอุณหภูมิ/ความชื้น/ประตูรายตัวเมื่อ
   * device มีมากกว่า 1 probe (LogDays.door1/2/3 เป็นค่าต่อแถว/ต่อ probeId อยู่แล้ว)
   */
  async findLatestTelemetryByDevice(deviceId: string): Promise<ProbeTelemetrySnapshot[]> {
    const probes = await this.prisma.probes.findMany({
      where: { deviceId },
      orderBy: { channel: 'asc' },
    });
    if (probes.length === 0) return [];

    // "แถวล่าสุดต่อ probeId" ในคิวรีเดียวด้วย distinct — ต้อง orderBy field ที่ distinct
    // ก่อน sendTime desc (Prisma greatest-n-per-group pattern)
    const latestLogs = await this.prisma.logDays.findMany({
      where: { probeId: { in: probes.map((p) => p.id) } },
      orderBy: [{ probeId: 'asc' }, { sendTime: 'desc' }],
      distinct: ['probeId'],
    });
    const byProbeId = new Map(latestLogs.map((log) => [log.probeId as string, log]));

    return probes.map((probe) => {
      const log = byProbeId.get(probe.id);
      return {
        id: probe.id,
        channel: probe.channel,
        name: probe.name,
        type: probe.type,
        doorQty: probe.doorQty,
        temp: log?.temp ?? null,
        tempDisplay: log?.tempDisplay ?? null,
        humidity: log?.humidity ?? null,
        humidityDisplay: log?.humidityDisplay ?? null,
        door1: log?.door1 ?? null,
        door2: log?.door2 ?? null,
        door3: log?.door3 ?? null,
        sendTime: log?.sendTime ?? null,
      };
    });
  }

  async findOne(id: string): Promise<Probes> {
    const probe = await this.prisma.probes.findUnique({ where: { id } });
    if (!probe) {
      throw new NotFoundException(`Probe ${id} not found`);
    }
    return probe;
  }

  async update(id: string, dto: UpdateProbeDto, actor?: DeviceChangeActor): Promise<Probes> {
    const probe = await this.prisma.probes.update({ where: { id }, data: dto });
    this.emitChanged('updated', probe, actor);
    return probe;
  }

  async remove(id: string, actor?: DeviceChangeActor): Promise<Probes> {
    const probe = await this.prisma.probes.delete({ where: { id } });
    this.emitChanged('deleted', probe, actor);
    return probe;
  }
}
