import { ForbiddenException, Injectable, Logger, MessageEvent } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, Subject, concat, defer } from 'rxjs';
import { filter, finalize, map } from 'rxjs/operators';
import { isWardScoped } from '../common/auth/ward-scope';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { AppEvents } from '../common/events/app-events';
import { DeviceChangedEvent } from '../common/events/device-changed.event';
import { DeviceAssignmentService } from '../device/device-assignment.service';
import { MetricsService } from '../observability/metrics.service';
import { PrismaService } from '../prisma/prisma.service';

interface RealtimeReading {
  serial: string;
  channel: string;
  temp: number;
  sendTime: Date;
}

export const SSE_CHANNELS = ['telemetry', 'notification', 'device'] as const;
export type SseChannel = (typeof SSE_CHANNELS)[number];

interface StreamEnvelope {
  channel: SseChannel;
  data: unknown;
  /** ward ของจุดติดตั้งที่ event นี้เกิด — null = ไม่รู้ (กล่องยังไม่ถูกติดตั้ง) */
  ward: string | null;
}

@Injectable()
export class SseService {
  private readonly logger = new Logger(SseService.name);
  private readonly stream$ = new Subject<StreamEnvelope>();
  /** stream แยกจาก stream$ เพราะ scope เป็นราย serial+channel ไม่ใช่ ward-scoped channel ทั่วไป */
  private readonly realtime$ = new Subject<RealtimeReading>();

  constructor(
    private readonly metrics: MetricsService,
    private readonly assignments: DeviceAssignmentService,
    private readonly prisma: PrismaService,
  ) {}

  /** broadcast ข้อมูลเข้า stream กลาง — ใช้ได้ทั้งจาก event handler และ service อื่นโดยตรง */
  broadcast(channel: SseChannel, data: unknown, ward: string | null = null): void {
    this.stream$.next({ channel, data, ward });
  }

  /** Observable ของ MessageEvent สำหรับ endpoint @Sse() เฉพาะ channel ที่ระบุ */
  streamFor(channel: SseChannel, user: JwtPayloadDto): Observable<MessageEvent> {
    return this.open([channel], channel, user);
  }

  /**
   * stream หลาย channel บน connection เดียว (endpoint multiplexed)
   *
   * ชื่อ event ยังเป็นชื่อ channel เหมือน endpoint แยก client จึงแยกด้วย
   * `addEventListener('device', ...)` ได้ตามปกติ — ประหยัดโควตา connection ของ browser
   * (HTTP/1.1 จำกัด 6 connection ต่อ host)
   */
  streamForChannels(
    channels: SseChannel[],
    user: JwtPayloadDto,
    metricLabel = 'multi',
  ): Observable<MessageEvent> {
    return this.open(channels, metricLabel, user);
  }

  /** นับ metric ครั้งเดียวต่อ connection ไม่ว่าจะ subscribe กี่ channel */
  private open(
    channels: SseChannel[],
    metricLabel: string,
    user: JwtPayloadDto,
  ): Observable<MessageEvent> {
    const wardScoped = isWardScoped(user);

    // defer + finalize เพื่อนับ connection ตอน client subscribe/disconnect จริง
    return defer(() => {
      this.metrics.sseConnectionOpened(metricLabel);
      return this.stream$.asObservable();
    }).pipe(
      filter((envelope) => channels.includes(envelope.channel)),
      // ward ที่ resolve ไม่ได้ (null) ถือว่าไม่ผ่าน scope — ปลอดภัยกว่าปล่อยรั่ว
      filter((envelope) => !wardScoped || envelope.ward === user.wardId),
      map((envelope): MessageEvent => ({ data: envelope.data as object, type: envelope.channel })),
      finalize(() => this.metrics.sseConnectionClosed(metricLabel)),
    );
  }

  /**
   * stream อุณหภูมิ realtime (~5s, ไม่บันทึก DB) ของอุปกรณ์+channel เดียว — ใช้ชั่วคราวตอน
   * ปรับค่าชดเชยเท่านั้น ไม่ใช่ dashboard monitoring ทั่วไป (ดู CLAUDE.md ส่วน adjust)
   *
   * emit ค่าล่าสุดจาก DB ทันที 1 ครั้งก่อน (กันจอว่างถ้าอุปกรณ์ยังไม่ส่ง live event ใหม่มา)
   * แล้วต่อด้วย live stream ที่ filter เฉพาะ serial+channel นี้ — ไม่มีการ subscribe/unsubscribe
   * MQTT จริง เพราะฝั่งอุปกรณ์ publish topic นี้อยู่แล้วตลอดเวลาไม่ว่าจะมีคนดูหรือไม่
   * cleanup ตอน client disconnect เกิดจาก finalize() ของ live$ เท่านั้น (แค่เลิก filter ฝั่งนี้)
   */
  async realtimeTemperatureStream(
    serial: string,
    channel: string,
    user: JwtPayloadDto,
  ): Promise<Observable<MessageEvent>> {
    if (isWardScoped(user)) {
      const ward = await this.wardOf(serial);
      if (ward !== user.wardId) {
        throw new ForbiddenException(`ไม่มีสิทธิ์ดู realtime ของอุปกรณ์ ${serial}`);
      }
    }

    const metricLabel = `realtime:${serial}:${channel}`;

    const initial$ = defer(() => this.lastKnownReading(serial, channel)).pipe(
      filter((reading): reading is RealtimeReading => reading !== null),
      map((reading): MessageEvent => ({ type: 'temperature', data: reading })),
    );

    const live$ = defer(() => {
      this.metrics.sseConnectionOpened(metricLabel);
      return this.realtime$.asObservable();
    }).pipe(
      filter((reading) => reading.serial === serial && reading.channel === channel),
      map((reading): MessageEvent => ({ type: 'temperature', data: reading })),
      finalize(() => this.metrics.sseConnectionClosed(metricLabel)),
    );

    return concat(initial$, live$);
  }

  private async lastKnownReading(serial: string, channel: string): Promise<RealtimeReading | null> {
    const row = await this.prisma.logDays.findFirst({
      where: { serial, probe: channel },
      orderBy: { sendTime: 'desc' },
      select: { temp: true, sendTime: true },
    });
    return row ? { serial, channel, temp: row.temp, sendTime: row.sendTime } : null;
  }

  /**
   * หา ward ของ event ที่มีแค่ serial (telemetry/notification) — อ่านผ่าน cache ของ
   * DeviceAssignmentService จึงเป็น Redis hit เกือบทุกครั้ง ไม่ใช่ query ต่อ event
   */
  private async wardOf(serial: unknown): Promise<string | null> {
    if (typeof serial !== 'string') return null;
    try {
      return await this.assignments.resolveWard(serial);
    } catch (err) {
      this.logger.warn(`resolve ward ของ ${serial} ล้มเหลว: ${(err as Error).message}`);
      return null;
    }
  }

  @OnEvent(AppEvents.TELEMETRY_CREATED)
  async handleTelemetryCreated(payload: unknown): Promise<void> {
    const ward = await this.wardOf((payload as { serial?: unknown })?.serial);
    this.broadcast('telemetry', payload, ward);
  }

  @OnEvent(AppEvents.TELEMETRY_REALTIME)
  handleTelemetryRealtime(payload: RealtimeReading): void {
    this.realtime$.next(payload);
  }

  @OnEvent(AppEvents.DEVICE_CHANGED)
  handleDeviceChanged(payload: DeviceChangedEvent): void {
    // event นี้พก device ทั้งก้อนมาอยู่แล้ว ไม่ต้อง resolve ward ซ้ำ
    this.broadcast('device', payload, payload.device?.ward ?? null);
  }
}
