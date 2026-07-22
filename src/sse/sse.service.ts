import { Injectable, Logger, MessageEvent } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, Subject, defer } from 'rxjs';
import { filter, finalize, map } from 'rxjs/operators';
import { AppEvents } from '../common/events/app-events';
import { MetricsService } from '../observability/metrics.service';

interface StreamEnvelope {
  channel: 'telemetry' | 'notification';
  data: unknown;
}

@Injectable()
export class SseService {
  private readonly logger = new Logger(SseService.name);
  private readonly stream$ = new Subject<StreamEnvelope>();

  constructor(private readonly metrics: MetricsService) {}

  /** broadcast ข้อมูลเข้า stream กลาง — ใช้ได้ทั้งจาก event handler และ service อื่นโดยตรง */
  broadcast(channel: StreamEnvelope['channel'], data: unknown): void {
    this.stream$.next({ channel, data });
  }

  /** Observable ของ MessageEvent สำหรับ endpoint @Sse() เฉพาะ channel ที่ระบุ */
  streamFor(channel: StreamEnvelope['channel']): Observable<MessageEvent> {
    // defer + finalize เพื่อนับ connection ตอน client subscribe/disconnect จริง
    return defer(() => {
      this.metrics.sseConnectionOpened(channel);
      return this.stream$.asObservable();
    }).pipe(
      filter((envelope) => envelope.channel === channel),
      map((envelope): MessageEvent => ({ data: envelope.data as object, type: channel })),
      finalize(() => this.metrics.sseConnectionClosed(channel)),
    );
  }

  @OnEvent(AppEvents.TELEMETRY_CREATED)
  handleTelemetryCreated(payload: unknown): void {
    this.broadcast('telemetry', payload);
  }

  @OnEvent(AppEvents.NOTIFICATION_CREATED)
  handleNotificationCreated(payload: unknown): void {
    this.broadcast('notification', payload);
  }
}
