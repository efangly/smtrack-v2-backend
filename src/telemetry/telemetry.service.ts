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
import { toPaginated } from '../common/pagination/paginate.util';
import { resolveRange } from '../common/time/range.util';
import { AccessScope, deviceWhere } from '../common/auth/access-scope';
import { RestoredWindowService } from '../backup/restored-window.service';
import { hotWindowStart } from '../backup/archive.util';

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
    private readonly restored: RestoredWindowService,
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
        let log: LogDays;
        try {
          log = await this.prisma.logDays.create({ data });
        } catch (err) {
          // (serial, probe, sendTime) ซ้ำ = log เดิมเข้ามาซ้ำ (QoS 1 redeliver / legacy sync ทับ backfill)
          // คืนแถวเดิม ไม่ emit event ซ้ำ ไม่ throw (ไม่งั้น RMQ จะ nack/requeue วนไม่จบ)
          if (!this.isDuplicateLog(err) || !data.sendTime) throw err;
          span.setAttribute('db.rows_affected', 0);
          span.setAttribute('telemetry.duplicate', true);
          this.logger.debug(`Duplicate telemetry for ${serial} probe ${channel} — skipped`);
          return this.prisma.logDays.findFirstOrThrow({
            where: { serial, probe: channel, sendTime: data.sendTime },
          });
        }
        this.metrics.recordIngestDuration(Date.now() - startedAt, serial);
        span.setAttribute('db.rows_affected', 1);

        this.logger.debug(`Stored telemetry for ${serial} @ ${log.sendTime.toISOString()}`);
        this.eventEmitter.emit(AppEvents.TELEMETRY_CREATED, log);
        return log;
      },
    );
  }

  private isDuplicateLog(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  }

  /** query log ย้อนหลังสำหรับ REST endpoint */
  async find(query: QueryTelemetryDto, scope: AccessScope): Promise<Paginated<LogDays>> {
    // serial/deviceId/serialOrName ทับซ้อนกันในความหมาย (จะกรองด้วย identity ไหนของ device)
    // ปล่อยให้ระบุมาพร้อมกันเงียบ ๆ จะทำให้ไม่รู้ว่าจริง ๆ ใช้ตัวไหนกรอง จึง reject ไปเลย
    const identityFields = [query.serial, query.deviceId, query.serialOrName].filter(Boolean);
    if (identityFields.length > 1) {
      throw new BadRequestException('ระบุ serial, deviceId หรือ serialOrName ได้เพียงอย่างเดียว');
    }

    // กรองรายแถวตามจุดติดตั้งที่ประทับไว้ตอน ingest — กล่องย้ายข้าม tenant ได้ ประวัติต้องอยู่กับ tenant เดิม
    // log ที่ไม่ผูกจุดติดตั้ง (deviceId null) เห็นได้เฉพาะ GLOBAL
    const where: Prisma.LogDaysWhereInput =
      scope.kind === 'GLOBAL' ? {} : { device: deviceWhere(scope) };
    if (query.serial) where.serial = query.serial;
    if (query.deviceId) where.deviceId = query.deviceId;
    // รับได้ทั้ง serial ของกล่องที่ติดตั้งอยู่ และ staticName ของจุดติดตั้ง — resolve เป็น deviceId
    // ก่อน query เสมอ จึงได้ประวัติต่อเนื่องข้ามการสลับเครื่อง เหมือน /graph กับ /logday
    if (query.serialOrName) {
      where.deviceId = await this.assignments.resolveDeviceIdOrThrow(query.serialOrName, scope);
    }
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

    // ข้อมูลนอก hot window: restore จาก archive (ถ้าจำเป็น) แล้วอ่านต่อจาก log_day_archive
    const archiveWhere = await this.prepareArchiveRead(where, scope);

    // limit/skip ต้องใช้ค่า default ตัวเดียวกัน — เดิม skip คิดจาก limit=20 แต่ take=100
    // หน้า 2 ที่ไม่ระบุ limit จึงซ้อนกับหน้า 1
    const limit = query.limit ?? 100;
    const skip = ((query.page ?? 1) - 1) * limit;

    const [hotTotal, archiveTotal] = await Promise.all([
      this.prisma.logDays.count({ where }),
      archiveWhere ? this.prisma.logDayArchive.count({ where: archiveWhere }) : 0,
    ]);

    // ผลเรียงใหม่→เก่า: แถวใน log_days (ใหม่กว่า) มาก่อน แล้วต่อด้วย archive (เก่ากว่า)
    // — ส่วนที่ถูก drop ไปแล้วคือส่วนต้นของเวลาเสมอ จึงไม่ซ้อนทับกัน
    const hotRows =
      archiveWhere === null || skip < hotTotal
        ? await this.prisma.logDays.findMany({
            where,
            orderBy: { sendTime: 'desc' },
            skip,
            take: archiveWhere === null ? limit : Math.min(limit, hotTotal - skip),
          })
        : [];
    const remaining = limit - hotRows.length;
    const archiveRows =
      archiveWhere && remaining > 0
        ? await this.prisma.logDayArchive.findMany({
            where: archiveWhere,
            orderBy: { sendTime: 'desc' },
            skip: Math.max(0, skip - hotTotal),
            take: remaining,
          })
        : [];

    const data: LogDays[] = [...hotRows, ...archiveRows];
    const total = hotTotal + archiveTotal;
    return toPaginated(data, total, { ...query, limit });
  }

  /**
   * ถ้าคำขอย้อนไปนอก hot window ของจุดติดตั้งที่ผู้เรียกเห็นได้ ให้ restore จาก archive แล้วคืน where
   * สำหรับอ่าน log_day_archive — คืน null เมื่อไม่ต้องอ่าน archive
   *
   * ต้องรู้ deviceId (archive ผูกกับจุดติดตั้ง) และต้องตรวจ scope เองเพราะ log_day_archive ไม่มี
   * relation ให้กรองผ่าน `device: deviceWhere(scope)` แบบ log_days
   */
  private async prepareArchiveRead(
    where: Prisma.LogDaysWhereInput,
    scope: AccessScope,
  ): Promise<Prisma.LogDayArchiveWhereInput | null> {
    const deviceId = typeof where.deviceId === 'string' ? where.deviceId : undefined;
    if (!deviceId) return null;

    const sendTime = where.sendTime as Prisma.DateTimeFilter | undefined;
    const from = sendTime?.gte as Date | undefined;
    const to = (sendTime?.lte as Date | undefined) ?? new Date();
    const boundary = hotWindowStart();

    if (!from) {
      if (to < boundary) {
        throw new BadRequestException(
          'ต้องระบุ from ด้วย เมื่อ to อยู่นอกช่วงที่เก็บไว้ในฐานข้อมูลหลัก',
        );
      }
      return null;
    }
    if (from >= boundary) return null;

    if (scope.kind !== 'GLOBAL') {
      const visible = await this.prisma.devices.count({
        where: { id: deviceId, ...deviceWhere(scope) },
      });
      if (visible === 0) return null;
    }

    await this.restored.ensureRange(deviceId, from, to);
    return {
      deviceId,
      sendTime: { gte: from, lte: to },
      ...(where.probeId ? { probeId: where.probeId as string } : {}),
      ...(where.probe ? { probe: where.probe as string } : {}),
    };
  }
}
