import { Controller, Logger, UseFilters, ValidationPipe } from '@nestjs/common';
import { Ctx, EventPattern, MqttContext, Payload } from '@nestjs/microservices';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SpanKind } from '@opentelemetry/api';
import { MqttExceptionFilter } from '../common/filters/mqtt-exception.filter';
import { TelemetryService } from '../telemetry/telemetry.service';
import { CreateTelemetryDto } from '../telemetry/dto/create-telemetry.dto';
import { RealtimeTelemetryDto } from '../telemetry/dto/realtime-telemetry.dto';
import { TraceService } from '../observability/trace.service';
import { MetricsService } from '../observability/metrics.service';
import { AppEvents } from '../common/events/app-events';

/**
 * topic ของ stream realtime (~5s, ไม่บันทึก DB) — แยกจาก MQTT_LOG_TOPIC (ทุก 5 นาที, บันทึกจริง)
 * ต้อง resolve เป็น literal ตอน decorator evaluate (ก่อน DI พร้อม) จึงอ่านจาก process.env ตรง ๆ
 * เหมือน `devices/+/log` — ยังไม่ได้ตกลง topic จริงกับฝั่ง firmware ให้กำหนดผ่าน MQTT_REALTIME_TOPIC
 */
const REALTIME_TOPIC = process.env.MQTT_REALTIME_TOPIC || 'devices/+/telemetry';

/**
 * MQTT message handlers — หน้าที่แค่รับ/แปลง payload แล้วเรียก service
 * (business logic อยู่ใน service เท่านั้น ตาม convention)
 */
@Controller()
@UseFilters(new MqttExceptionFilter())
export class MqttController {
  private readonly logger = new Logger(MqttController.name);

  constructor(
    private readonly telemetryService: TelemetryService,
    private readonly traceService: TraceService,
    private readonly metrics: MetricsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @EventPattern('devices/+/log')
  async handleDeviceLog(
    @Payload(new ValidationPipe({ transform: true, whitelist: true }))
    payload: CreateTelemetryDto,
    @Ctx() context: MqttContext,
  ): Promise<void> {
    const topic = context.getTopic();
    // ถ้า payload ไม่ได้ระบุ serial ให้ดึงจาก topic devices/{serial}/log
    // (DTO ปล่อย serial เป็น optional ไว้เพื่อให้เติมตรงนี้ได้ — TelemetryService เป็นคนบังคับว่าต้องมี)
    payload.serial = payload.serial?.trim() || this.extractSerial(topic);

    // span นี้เป็น root ของ ingest flow — mqtt ไม่มี auto-instrumentation
    await this.traceService.withSpan(
      `mqtt.consume ${topic}`,
      {
        'messaging.system': 'mqtt',
        'messaging.operation': 'process',
        'messaging.destination.name': topic,
        'device.serial': payload.serial,
      },
      async () => {
        try {
          await this.telemetryService.ingest(payload);
          this.metrics.recordMqttMessage(topic, 'success');
        } catch (err) {
          this.metrics.recordMqttMessage(topic, 'error');
          throw err;
        }
      },
      SpanKind.CONSUMER,
    );
  }

  /**
   * รับข้อมูล realtime (~5s, ไม่บันทึก DB) — ต่างจาก handleDeviceLog: ไม่มี PrismaService/ingest,
   * แค่ยิง event ภายในให้ sse module filter ตาม serial+channel ต่อ connection ที่กำลังดูอยู่
   * (ไม่มี "ผู้ดู" ก็ไม่มีผลอะไรต่อ นอกจากเข้า listener เฉย ๆ — ประหยัด/ตัดออกทั้ง flow เป็นเรื่องของ
   * ฝั่งอุปกรณ์/firmware ไม่ใช่ backend นี้)
   */
  @EventPattern(REALTIME_TOPIC)
  handleDeviceRealtime(
    @Payload(new ValidationPipe({ transform: true, whitelist: true }))
    payload: RealtimeTelemetryDto,
    @Ctx() context: MqttContext,
  ): void {
    const topic = context.getTopic();
    const serial = payload.serial?.trim() || this.extractSerial(topic);
    if (!serial || payload.temp === undefined) {
      this.logger.warn(`realtime payload ไม่มี serial/temp ทิ้งข้อความจาก ${topic}`);
      this.metrics.recordMqttMessage(topic, 'error');
      return;
    }

    this.eventEmitter.emit(AppEvents.TELEMETRY_REALTIME, {
      serial,
      channel: payload.probe?.trim() || '1',
      temp: payload.temp,
      sendTime: payload.sendTime ? new Date(payload.sendTime) : new Date(),
    });
    this.metrics.recordMqttMessage(topic, 'success');
  }

  private extractSerial(topic: string): string {
    const parts = topic.split('/');
    return parts[1] ?? '';
  }
}
