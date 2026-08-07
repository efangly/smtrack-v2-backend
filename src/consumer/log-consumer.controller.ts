import { Controller } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { SpanKind } from '@opentelemetry/api';
import { TelemetryService } from '../telemetry/telemetry.service';
import { CreateTelemetryDto } from '../telemetry/dto/create-telemetry.dto';
import { TraceService } from '../observability/trace.service';
import { MetricsService } from '../observability/metrics.service';
import { ackOrNack } from './rmq-ack.util';
import { validatePayload } from './validate-payload.util';

const QUEUE_NAME = 'log_queue';

/**
 * รับ log/telemetry ผ่าน RabbitMQ (queue แยกจาก device online/offline เพราะปริมาณสูงกว่ามาก)
 * handler แค่รับ/validate payload แล้วเรียก TelemetryService.ingest() ตัวเดียวกับ MQTT/HTTP — ไม่มี insert logic ซ้ำ
 */
@Controller()
export class LogConsumerController {
  constructor(
    private readonly telemetryService: TelemetryService,
    private readonly traceService: TraceService,
    private readonly metrics: MetricsService,
  ) {}

  @EventPattern('device-log')
  async handleDeviceLog(@Payload() payload: unknown, @Ctx() context: RmqContext): Promise<void> {
    await ackOrNack(context, 'device-log', payload, async () => {
      try {
        // validate ข้างในนี้ ไม่ใช่ที่ @Payload() — เหตุผลใน validate-payload.util.ts
        const dto = await validatePayload(CreateTelemetryDto, payload);
        await this.traceService.withSpan(
          `rmq.consume ${QUEUE_NAME}`,
          {
            'messaging.system': 'rabbitmq',
            'messaging.operation': 'process',
            'messaging.destination.name': QUEUE_NAME,
            'device.serial': dto.serial,
          },
          () => this.telemetryService.ingest(dto),
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
