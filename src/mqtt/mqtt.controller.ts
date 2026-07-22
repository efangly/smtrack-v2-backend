import { Controller, Logger, UseFilters, ValidationPipe } from '@nestjs/common';
import { Ctx, EventPattern, MqttContext, Payload } from '@nestjs/microservices';
import { SpanKind } from '@opentelemetry/api';
import { MqttExceptionFilter } from '../common/filters/mqtt-exception.filter';
import { TelemetryService } from '../telemetry/telemetry.service';
import { CreateTelemetryDto } from '../telemetry/dto/create-telemetry.dto';
import { TraceService } from '../observability/trace.service';
import { MetricsService } from '../observability/metrics.service';

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

  private extractSerial(topic: string): string {
    const parts = topic.split('/');
    return parts[1] ?? '';
  }
}
