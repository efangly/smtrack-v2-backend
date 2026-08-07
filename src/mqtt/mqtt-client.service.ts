import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, MqttClient, IClientPublishOptions } from 'mqtt';
import { SpanKind } from '@opentelemetry/api';
import { TraceService } from '../observability/trace.service';
import { MetricsService } from '../observability/metrics.service';

/**
 * Wrapper สำหรับ publish ไปยัง MQTT broker (notification, command)
 * ดูแล reconnect เอง เพราะทั้ง log ingestion และ notification พึ่ง MQTT ช่องทางเดียว
 */
@Injectable()
export class MqttClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttClientService.name);
  private client?: MqttClient;

  constructor(
    private readonly config: ConfigService,
    private readonly traceService: TraceService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    const url = this.config.get<string>('mqtt.brokerUrl')!;
    this.client = connect(url, {
      username: this.config.get<string>('mqtt.username'),
      password: this.config.get<string>('mqtt.password'),
      clientId: `${this.config.get<string>('mqtt.clientId')}-pub`,
      reconnectPeriod: 5000,
      connectTimeout: 30_000,
      keepalive: 60,
    });

    this.client.on('connect', () => this.logger.log(`MQTT publisher connected to ${url}`));
    this.client.on('reconnect', () => this.logger.warn('MQTT publisher reconnecting...'));
    this.client.on('error', (err) => this.logger.error(`MQTT publisher error: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.endAsync();
  }

  /**
   * publish payload JSON ไปยัง topic
   * @param qos ค่าเริ่มต้น 1 — notification/command เป็นข้อมูลสำคัญ
   */
  async publish(
    topic: string,
    payload: unknown,
    options: IClientPublishOptions = { qos: 1 },
  ): Promise<void> {
    if (!this.client) {
      throw new Error('MQTT client not initialized');
    }
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);

    await this.traceService.withSpan(
      `mqtt.publish ${topic}`,
      {
        'messaging.system': 'mqtt',
        'messaging.operation': 'publish',
        'messaging.destination.name': topic,
        'messaging.message.body.size': message.length,
        'messaging.mqtt.qos': options.qos ?? 1,
      },
      async () => {
        try {
          await this.client!.publishAsync(topic, message, options);
          this.metrics.recordMqttMessage(topic, 'success');
        } catch (err) {
          this.metrics.recordMqttMessage(topic, 'error');
          throw err;
        }
      },
      SpanKind.PRODUCER,
    );
    this.logger.debug(`Published to ${topic}`);
  }

  /** publish การแจ้งเตือนไปยัง notification/{serial} */
  /** publish การแจ้งเตือนไปยัง notification/{deviceId} — deviceId คือจุดติดตั้ง ไม่ใช่ serial ของกล่อง */
  async publishNotification(deviceId: string, payload: unknown): Promise<void> {
    const prefix = this.config.get<string>('mqtt.notificationTopicPrefix');
    await this.publish(`${prefix}/${deviceId}`, payload, { qos: 1 });
  }

  /** publish command ไปยังอุปกรณ์ devices/{serial}/command */
  async publishCommand(serial: string, payload: unknown): Promise<void> {
    await this.publish(`devices/${serial}/command`, payload, { qos: 1 });
  }
}
