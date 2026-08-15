import {
  BadRequestException,
  Controller,
  MessageEvent,
  Param,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { merge, Observable, interval } from 'rxjs';
import { map } from 'rxjs/operators';
import { SSE_CHANNELS, SseChannel, SseService } from './sse.service';
import { SkipInterceptor } from '../common/decorators/skip-interceptor.decorator';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { SseAuthGuard } from '../common/guards/sse.guard';

type AuthedRequest = Request & { user: JwtPayloadDto };

/**
 * ทุก stream ต้องยืนยันตัวตน และ role ที่ถูก scope (USER/GUEST/LEGACY_USER) จะได้รับเฉพาะ
 * event ของ ward ตัวเอง — กรองที่ฝั่ง server ไม่ใช่ให้ client กรองเอง
 *
 * รับ token ได้ทั้ง `Authorization: Bearer` และ `?token=` เพราะ EventSource ตั้ง header ไม่ได้
 */
@ApiTags('sse')
@ApiBearerAuth('jwt')
@ApiQuery({
  name: 'token',
  required: false,
  description: 'JWT สำหรับ EventSource ที่ตั้ง header ไม่ได้',
})
@UseGuards(SseAuthGuard)
@Controller()
export class SseController {
  constructor(private readonly sseService: SseService) {}

  /**
   * ต้อง @SkipInterceptor() ทุก endpoint ที่เป็น SSE
   *
   * ResponseInterceptor ถูกติดตั้งเป็น global ใน main.ts และมัน map ทุกค่าที่ไหลออกจาก handler
   * สำหรับ @Sse() ค่าที่ไหลออกคือ MessageEvent ทีละตัวตลอดอายุ connection ไม่ใช่ response ก้อนเดียว
   * ถ้าไม่ skip แต่ละ event จะถูกห่อเป็น { success, message, data, ... } ทำให้ field `type`
   * (ชื่อ event) หายไป client จึงได้ event ไม่มีชื่อและ payload ซ้อนอีกชั้น
   */
  @Sse('telemetry/stream')
  @SkipInterceptor()
  telemetryStream(@Req() req: AuthedRequest): Observable<MessageEvent> {
    return this.withHeartbeat(this.sseService.streamFor('telemetry', req.user));
  }

  @Sse('notifications/stream')
  @SkipInterceptor()
  notificationStream(@Req() req: AuthedRequest): Observable<MessageEvent> {
    return this.withHeartbeat(this.sseService.streamFor('notification', req.user));
  }

  /** การเปลี่ยนแปลงของจุดติดตั้ง — online/offline, แก้ข้อมูล, สลับกล่อง */
  @Sse('devices/stream')
  @SkipInterceptor()
  deviceStream(@Req() req: AuthedRequest): Observable<MessageEvent> {
    return this.withHeartbeat(this.sseService.streamFor('device', req.user));
  }

  /**
   * อุณหภูมิ realtime (~5s, ไม่บันทึก DB) ของอุปกรณ์+channel เดียว — ใช้ชั่วคราวตอน frontend
   * เปิดหน้าปรับค่าชดเชยเท่านั้น ปิดหน้าจอ/ปิด connection ก็เลิก filter ทันที ไม่ใช่ dashboard
   * monitoring ทั่วไป (นั้นใช้ `telemetry/stream` แทน)
   */
  @Sse('telemetry/:serial/:channel/stream')
  @SkipInterceptor()
  async realtimeTemperatureStream(
    @Req() req: AuthedRequest,
    @Param('serial') serial: string,
    @Param('channel') channel: string,
  ): Promise<Observable<MessageEvent>> {
    return this.withHeartbeat(
      await this.sseService.realtimeTemperatureStream(serial, channel, req.user),
    );
  }

  /**
   * stream รวมทุก channel บน connection เดียว สำหรับหน้า dashboard ที่ต้องการทั้ง
   * telemetry, notification และสถานะ device พร้อมกัน โดยไม่กิน connection ของ browser หลายช่อง
   */
  @Sse('stream')
  @SkipInterceptor()
  @ApiQuery({
    name: 'channels',
    required: false,
    description: `รายชื่อ channel คั่นด้วย , (${SSE_CHANNELS.join(' | ')}) — ไม่ระบุ = ทุก channel`,
    example: 'device,telemetry',
  })
  multiStream(
    @Req() req: AuthedRequest,
    @Query('channels') channels?: string,
  ): Observable<MessageEvent> {
    return this.withHeartbeat(this.sseService.streamForChannels(parseChannels(channels), req.user));
  }

  /** ผสม heartbeat event ทุก 30s กัน proxy/LB ตัด connection ที่เงียบนาน */
  private withHeartbeat(source$: Observable<MessageEvent>): Observable<MessageEvent> {
    const heartbeat$ = interval(30_000).pipe(
      map((): MessageEvent => ({ type: 'heartbeat', data: { ts: Date.now() } })),
    );
    return merge(source$, heartbeat$);
  }
}

/** ไม่ระบุ = ทุก channel; ระบุชื่อที่ไม่รู้จัก = 400 ไม่ใช่เงียบ ๆ แล้วไม่มี event มาเลย */
function parseChannels(raw?: string): SseChannel[] {
  if (!raw?.trim()) return [...SSE_CHANNELS];

  const requested = raw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  const unknown = requested.filter((c) => !SSE_CHANNELS.includes(c as SseChannel));
  if (unknown.length > 0) {
    throw new BadRequestException(
      `channel ไม่ถูกต้อง: ${unknown.join(', ')} (รองรับ: ${SSE_CHANNELS.join(', ')})`,
    );
  }
  return requested.length > 0 ? (requested as SseChannel[]) : [...SSE_CHANNELS];
}
