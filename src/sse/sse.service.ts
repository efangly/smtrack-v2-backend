import { ForbiddenException, Injectable, Logger, MessageEvent } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, Subject, concat, defer, from, of } from 'rxjs';
import { concatMap, filter, finalize, map } from 'rxjs/operators';
import { DeviceLocation, canAccess, scopeKey } from '../common/auth/access-scope';
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

/** นับ unread ตาม scope ของผู้ใช้ — NotificationService เป็นคน register (เลี่ยง circular DI) */
export type UnreadCounter = (user: JwtPayloadDto) => Promise<number>;

interface StreamEnvelope {
  channel: SseChannel;
  data: unknown;
  /** tenant/department ของจุดติดตั้งที่ event นี้เกิด — null = ไม่รู้ (เห็นได้เฉพาะ GLOBAL) */
  location: DeviceLocation;
  /**
   * unreadCount ที่คำนวณใหม่ต่อ scope ของผู้รับ ผูกกับ event นี้เท่านั้น — subscriber ที่ scope
   * เดียวกันใช้ query เดียวกัน และไม่มี cache ข้าม event ที่จะคืนเลขเก่าหลัง mark read
   */
  unreadByScope: Map<string, Promise<number>>;
}

@Injectable()
export class SseService {
  private readonly logger = new Logger(SseService.name);
  private readonly stream$ = new Subject<StreamEnvelope>();
  /** stream แยกจาก stream$ เพราะ scope เป็นราย serial+channel ไม่ใช่ channel ทั่วไปที่กรองตาม scope ผู้ใช้ */
  private readonly realtime$ = new Subject<RealtimeReading>();
  private unreadCounter: UnreadCounter | null = null;

  constructor(
    private readonly metrics: MetricsService,
    private readonly assignments: DeviceAssignmentService,
    private readonly prisma: PrismaService,
  ) {}

  /** broadcast ข้อมูลเข้า stream กลาง — ใช้ได้ทั้งจาก event handler และ service อื่นโดยตรง */
  broadcast(
    channel: SseChannel,
    data: unknown,
    location: DeviceLocation = { tenantId: null, departmentId: null },
  ): void {
    this.stream$.next({ channel, data, location, unreadByScope: new Map() });
  }

  registerUnreadCounter(counter: UnreadCounter): void {
    this.unreadCounter = counter;
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
    // defer + finalize เพื่อนับ connection ตอน client subscribe/disconnect จริง
    return defer(() => {
      this.metrics.sseConnectionOpened(metricLabel);
      return this.stream$.asObservable();
    }).pipe(
      filter((envelope) => channels.includes(envelope.channel)),
      filter((envelope) => canAccess(user.scope, envelope.location)),
      concatMap((envelope) => this.withUserUnreadCount(envelope, user)),
      map((event): MessageEvent => ({ data: event.payload, type: event.type })),
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
    if (user.scope.kind !== 'GLOBAL') {
      const location = await this.locationOf(serial);
      if (!canAccess(user.scope, location)) {
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
   * unreadCount ที่แนบมากับ event นับแค่ department ที่เกิด event แต่ผู้รับเห็นได้ทั้ง tenant หรือหลาย
   * department จึงนับใหม่ตาม scope ของผู้รับ — GLOBAL ใช้ค่าที่แนบมาเหมือนเดิม
   * นับไม่สำเร็จก็ส่ง event ต่อด้วยค่าเดิม ไม่ทิ้ง event ทั้งก้อน
   */
  private withUserUnreadCount(
    envelope: StreamEnvelope,
    user: JwtPayloadDto,
  ): Observable<{ type: SseChannel; payload: object }> {
    const data = envelope.data as Record<string, unknown>;
    const plain = { type: envelope.channel, payload: data };
    if (
      envelope.channel !== 'notification' ||
      !this.unreadCounter ||
      user.scope.kind === 'GLOBAL' ||
      typeof data?.unreadCount !== 'number'
    ) {
      return of(plain);
    }
    const key = scopeKey(user.scope);
    let count = envelope.unreadByScope.get(key);
    if (!count) {
      count = this.unreadCounter(user);
      envelope.unreadByScope.set(key, count);
    }
    return from(
      count.then(
        (unreadCount) => ({ type: envelope.channel, payload: { ...data, unreadCount } }),
        (err: Error) => {
          this.logger.warn(`นับ unread ตาม scope ผู้ใช้ล้มเหลว: ${err.message}`);
          return plain;
        },
      ),
    );
  }

  /**
   * หา tenant/department ของ event ที่มีแค่ serial (telemetry/notification) — อ่านผ่าน cache ของ
   * DeviceAssignmentService จึงเป็น Redis hit เกือบทุกครั้ง ไม่ใช่ query ต่อ event
   */
  private async locationOf(serial: unknown): Promise<DeviceLocation> {
    const unknown: DeviceLocation = { tenantId: null, departmentId: null };
    if (typeof serial !== 'string') return unknown;
    try {
      return await this.assignments.resolveLocation(serial);
    } catch (err) {
      this.logger.warn(`resolve location ของ ${serial} ล้มเหลว: ${(err as Error).message}`);
      return unknown;
    }
  }

  @OnEvent(AppEvents.TELEMETRY_CREATED)
  async handleTelemetryCreated(payload: unknown): Promise<void> {
    const location = await this.locationOf((payload as { serial?: unknown })?.serial);
    this.broadcast('telemetry', payload, location);
  }

  @OnEvent(AppEvents.TELEMETRY_REALTIME)
  handleTelemetryRealtime(payload: RealtimeReading): void {
    this.realtime$.next(payload);
  }

  @OnEvent(AppEvents.DEVICE_CHANGED)
  handleDeviceChanged(payload: DeviceChangedEvent): void {
    // event นี้พก device ทั้งก้อนมาอยู่แล้ว ไม่ต้อง resolve location ซ้ำ
    this.broadcast('device', payload, {
      tenantId: payload.device?.tenantId ?? null,
      departmentId: payload.device?.departmentId ?? null,
    });
  }
}
