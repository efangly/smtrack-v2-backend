import { Controller } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { SpanKind } from '@opentelemetry/api';
import { NotificationService } from '../notification/notification.service';
import { CreateNotificationDto } from '../notification/dto/create-notification.dto';
import { TraceService } from '../observability/trace.service';
import { MetricsService } from '../observability/metrics.service';
import { ackOrNack } from './rmq-ack.util';
import { validatePayload } from './validate-payload.util';

// queue เดียวกับ device-log (buildRmqLogOptions) — Nest route ตาม pattern ภายใน queue
const QUEUE_NAME = 'log_queue';

/**
 * token ที่ขึ้นต้น message แล้วหมายถึงการแจ้งเตือน "ระดับกล่อง" ไม่ใช่ชื่อ probe
 * (ไฟดับ / เน็ตหลุด / SD card / รายงานตามรอบ / อุณหภูมิรวมของกล่อง)
 */
const BOX_LEVEL_TOKENS = new Set(['TEMP', 'SD', 'AC', 'INTERNET', 'REPORT']);

/**
 * ดึง channel ของ probe ต้นเหตุออกจาก message ของ smtrack-log-service
 *
 * ฝั่งต้นทางไม่ได้ส่ง field `probe` มาแยก แต่ format ของ message บอกไว้อยู่แล้ว —
 * `<probe>/DOOR<n>/<ON|OFF>`, `<probe>/TEMP/<OVER|LOWER>/<ค่า>`, `<probe>/SENSOR/<ON|OFF>`
 * ส่วน `AC/OFF`, `SD/OFF`, `INTERNET/OFF`, `TEMP/...`, `REPORT/...` เป็นระดับกล่อง
 * (ดู setDetailMessage ใน smtrack-log-service/src/notification/notification.service.ts)
 *
 * ⚠️ token ของ probe ที่ส่งมาจริงคือ `PROBE1`/`PROBE2` ไม่ใช่เลขเปล่า — ยืนยันจากข้อมูลจริง
 * ในตาราง notifications (PROBE1 877k แถว, PROBE2 71k แถว, ไม่มีเลขเปล่าสักแถว) แต่
 * `probes.channel` ของ v2 เก็บเป็น `'1'`/`'2'` ซึ่งเป็นค่าเดียวกับที่ log ส่งมาใน field `probe`
 * จึงต้องตัดคำนำหน้าออกให้เหลือแต่เลข ไม่งั้น resolveProbeId จะ auto-provision probe
 * ปลอมชื่อ `PROBE1` ขึ้นมาซ้ำกับของจริงทุกกล่อง แล้ว notification ไป join กับ log ไม่ติด
 *
 * head ที่ไม่เข้าทั้งสองแบบถือเป็นระดับกล่อง (คืน undefined) แทนที่จะส่งต่อดิบ ๆ —
 * ยอมเสียการผูก probe ดีกว่าปล่อยให้ค่าที่อ่านไม่ออกไปสร้าง probe ขยะในฐานข้อมูล
 */
export function deriveProbeChannel(message: string): string | undefined {
  const head = message.split('/')[0]?.trim().toUpperCase();
  if (!head || BOX_LEVEL_TOKENS.has(head)) return undefined;
  return /^(?:PROBE)?(\d+)$/.exec(head)?.[1];
}

/**
 * รับการแจ้งเตือนที่ smtrack-log-service (legacy) ยิงมาผ่าน RabbitMQ
 * handler แค่รับ/validate/แปลง payload แล้วเรียก NotificationService.create() ตัวเดียวกับ
 * REST/MQTT — DB write + fan-out MQTT/SSE/FCM อยู่ใน service ทั้งหมด ไม่มี logic ซ้ำที่นี่
 */
@Controller()
export class NotificationConsumerController {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly traceService: TraceService,
    private readonly metrics: MetricsService,
  ) {}

  @EventPattern('device-notification')
  async handleDeviceNotification(
    @Payload() payload: unknown,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    await ackOrNack(context, 'device-notification', payload, async () => {
      try {
        // validate ข้างในนี้ ไม่ใช่ที่ @Payload() — เหตุผลใน validate-payload.util.ts
        // field ที่ v2 ไม่มี (id / status / createAt / updateAt) ถูก whitelist ตัดทิ้งตรงนี้
        const dto = await validatePayload(CreateNotificationDto, payload);
        dto.probe = dto.probe?.trim() || deriveProbeChannel(dto.message);

        await this.traceService.withSpan(
          `rmq.consume ${QUEUE_NAME}`,
          {
            'messaging.system': 'rabbitmq',
            'messaging.operation': 'process',
            'messaging.destination.name': QUEUE_NAME,
            'device.serial': dto.serial,
          },
          () => this.notificationService.create(dto),
          SpanKind.CONSUMER,
        );
        this.metrics.recordRmqMessage(QUEUE_NAME, 'success');
      } catch (err) {
        this.metrics.recordRmqMessage(QUEUE_NAME, 'error');
        throw err;
      }
    });
  }
}
