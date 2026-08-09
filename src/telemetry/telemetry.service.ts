import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, LogDays } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppEvents } from '../common/events/app-events';
import { CreateTelemetryDto } from './dto/create-telemetry.dto';
import { QueryTelemetryDto } from './dto/query-telemetry.dto';
import { TraceService } from '../observability/trace.service';
import { MetricsService } from '../observability/metrics.service';
import { DeviceAssignmentService } from '../device/device-assignment.service';
import { ProbeResolverService } from '../probe/probe-resolver.service';
import { Paginated } from '../common/pagination/paginated.dto';
import { paginationSkip, toPaginated } from '../common/pagination/paginate.util';
import { resolveRange } from '../common/time/range.util';

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly traceService: TraceService,
    private readonly metrics: MetricsService,
    private readonly assignments: DeviceAssignmentService,
    private readonly probes: ProbeResolverService,
  ) {}

  /**
   * บันทึก log/telemetry ลง TimescaleDB (LogDays) แล้วยิง internal event
   * เพื่อให้ sse module push ไปยัง client ที่ subscribe อยู่แบบ real-time
   */
  async ingest(dto: CreateTelemetryDto): Promise<LogDays> {
    // serial เป็น optional ใน DTO (อาจมาจาก topic) — business rule ว่า "ต้องมี" บังคับที่นี่
    const serial = dto.serial?.trim();
    if (!serial) {
      throw new BadRequestException('serial is required (from payload or topic)');
    }

    // ประทับจุดติดตั้ง ณ เวลาที่ log เข้ามา — คืน null ได้ถ้ากล่องยังไม่ถูกติดตั้งที่ไหน
    // (เพิ่งซ่อมเสร็จ/อยู่ในคลัง) ซึ่งยังต้องเก็บ log ได้ ไม่ reject
    const deviceId = await this.assignments.resolveDeviceId(serial);

    // ผูก log กับ probe (device -> probe -> logdays) เพื่อให้แยกเส้นกราฟ/rollup ต่อ probe ได้
    // ไม่มี deviceId ก็ไม่มี Probes ให้ผูก — เก็บไว้แค่ channel ดิบในคอลัมน์ `probe`
    const channel = dto.probe?.trim() || '1';
    const probeId = deviceId ? await this.probes.resolveProbeId(deviceId, channel) : null;

    const data: Prisma.LogDaysCreateInput = {
      hardware: { connect: { serial } },
      ...(deviceId ? { device: { connect: { id: deviceId } } } : {}),
      ...(probeId ? { probeRef: { connect: { id: probeId } } } : {}),
      temp: dto.temp,
      tempDisplay: dto.tempDisplay,
      humidity: dto.humidity,
      humidityDisplay: dto.humidityDisplay,
      sendTime: dto.sendTime ? new Date(dto.sendTime) : undefined,
      plug: dto.plug,
      door1: dto.door1,
      door2: dto.door2,
      door3: dto.door3,
      internet: dto.internet,
      probe: channel,
      battery: dto.battery,
      tempInternal: dto.tempInternal,
      extMemory: dto.extMemory,
    };

    return this.traceService.withSpan(
      'telemetry.ingest',
      { 'device.serial': serial, 'probe.channel': channel, 'db.system': 'postgresql' },
      async (span) => {
        const startedAt = Date.now();
        const log = await this.prisma.logDays.create({ data });
        this.metrics.recordIngestDuration(Date.now() - startedAt, serial);
        span.setAttribute('db.rows_affected', 1);

        this.logger.debug(`Stored telemetry for ${serial} @ ${log.sendTime.toISOString()}`);
        this.eventEmitter.emit(AppEvents.TELEMETRY_CREATED, log);
        return log;
      },
    );
  }

  /** query log ย้อนหลังสำหรับ REST endpoint */
  async find(query: QueryTelemetryDto): Promise<Paginated<LogDays>> {
    const where: Prisma.LogDaysWhereInput = {};
    if (query.serial) where.serial = query.serial;
    if (query.deviceId) where.deviceId = query.deviceId;
    if (query.probeId) where.probeId = query.probeId;
    if (query.probe) where.probe = query.probe;
    if (query.range) {
      const { from, to } = resolveRange(query.range, query.from, query.to);
      where.sendTime = { gte: from, lte: to };
    } else if (query.from || query.to) {
      where.sendTime = {};
      if (query.from) where.sendTime.gte = new Date(query.from);
      if (query.to) where.sendTime.lte = new Date(query.to);
    }

    const [data, total] = await Promise.all([
      this.prisma.logDays.findMany({
        where,
        orderBy: { sendTime: 'desc' },
        skip: paginationSkip(query),
        take: query.limit ?? 100,
      }),
      this.prisma.logDays.count({ where }),
    ]);
    return toPaginated(data, total, query);
  }
}
