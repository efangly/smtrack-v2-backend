import { Controller, MessageEvent, Sse } from '@nestjs/common';
import { merge, Observable, interval } from 'rxjs';
import { map } from 'rxjs/operators';
import { SseService } from './sse.service';

@Controller()
export class SseController {
  constructor(private readonly sseService: SseService) {}

  @Sse('telemetry/stream')
  telemetryStream(): Observable<MessageEvent> {
    return this.withHeartbeat(this.sseService.streamFor('telemetry'));
  }

  @Sse('notifications/stream')
  notificationStream(): Observable<MessageEvent> {
    return this.withHeartbeat(this.sseService.streamFor('notification'));
  }

  /** ผสม heartbeat comment event ทุก 30s กัน proxy/LB ตัด connection ที่เงียบนาน */
  private withHeartbeat(source$: Observable<MessageEvent>): Observable<MessageEvent> {
    const heartbeat$ = interval(30_000).pipe(
      map((): MessageEvent => ({ type: 'heartbeat', data: { ts: Date.now() } })),
    );
    return merge(source$, heartbeat$);
  }
}
