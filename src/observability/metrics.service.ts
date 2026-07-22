import { Injectable } from '@nestjs/common';
import { Counter, Histogram, UpDownCounter, metrics } from '@opentelemetry/api';

const METER_NAME = 'smtrack-backend';

/**
 * Business metric ที่ auto-instrumentation ให้ไม่ได้
 * (HTTP/DB/Redis metric มาจาก auto-instrumentation อยู่แล้ว)
 * ส่งออกผ่าน OTLP metric reader ที่ตั้งไว้ใน tracing.ts — ไม่มี /metrics endpoint
 */
@Injectable()
export class MetricsService {
  private readonly meter = metrics.getMeter(METER_NAME);

  private readonly mqttMessages: Counter = this.meter.createCounter('smtrack_mqtt_messages_total', {
    description: 'จำนวน MQTT message ที่ consume/publish',
  });

  // ห้ามใส่หน่วยในชื่อ metric — OTel→Prometheus จะเติม suffix จาก `unit` ให้เอง
  // ("..._duration_ms" + unit ms จะกลายเป็น smtrack_telemetry_ingest_duration_ms_milliseconds)
  private readonly ingestDuration: Histogram = this.meter.createHistogram(
    'smtrack_telemetry_ingest_duration',
    { description: 'เวลาที่ใช้บันทึก telemetry ลง TimescaleDB', unit: 'ms' },
  );

  private readonly notificationDelivery: Counter = this.meter.createCounter(
    'smtrack_notification_delivery_total',
    { description: 'ผลการส่ง notification แยกตามช่องทาง' },
  );

  private readonly sseConnections: UpDownCounter = this.meter.createUpDownCounter(
    'smtrack_sse_active_connections',
    { description: 'จำนวน SSE connection ที่เปิดค้างอยู่' },
  );

  recordMqttMessage(topic: string, status: 'success' | 'error'): void {
    this.mqttMessages.add(1, { topic, status });
  }

  recordIngestDuration(ms: number, serial: string): void {
    this.ingestDuration.record(ms, { serial });
  }

  recordNotificationDelivery(channel: 'sse' | 'fcm', status: 'success' | 'error'): void {
    this.notificationDelivery.add(1, { channel, status });
  }

  sseConnectionOpened(channel: string): void {
    this.sseConnections.add(1, { channel });
  }

  sseConnectionClosed(channel: string): void {
    this.sseConnections.add(-1, { channel });
  }
}
