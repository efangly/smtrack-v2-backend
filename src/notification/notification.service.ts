import { Injectable, Logger } from '@nestjs/common';
import { Notifications } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MqttClientService } from '../mqtt/mqtt-client.service';
import { SseService } from '../sse/sse.service';
import { FcmService } from '../fcm/fcm.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { TraceService } from '../observability/trace.service';
import { MetricsService } from '../observability/metrics.service';

const bySerialKey = (serial: string) => `notification:${serial}`;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly mqttClient: MqttClientService,
    private readonly sseService: SseService,
    private readonly fcmService: FcmService,
    private readonly traceService: TraceService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * สร้างการแจ้งเตือน แล้ว fan-out ผ่าน MQTT + SSE + FCM
   * - SSE / FCM เป็นคนละ concern กัน wrap try/catch แยก ไม่ให้ทางหนึ่งพังบล็อกอีกทาง
   * - อัปเดต deliveredSse / deliveredFcm ตามผลจริง
   */
  async create(dto: CreateNotificationDto): Promise<Notifications> {
    const notification = await this.prisma.notifications.create({
      data: {
        serial: dto.serial,
        message: dto.message,
        detail: dto.detail ?? '',
      },
    });
    await this.redis.del(bySerialKey(dto.serial));

    // publish ผ่าน MQTT topic notification/{serial} (log/notify เดินผ่าน MQTT เท่านั้น)
    try {
      await this.mqttClient.publishNotification(dto.serial, notification);
    } catch (err) {
      this.logger.error(`MQTT publish notification failed: ${this.msg(err)}`);
    }

    const [deliveredSse, deliveredFcm] = await this.traceService.withSpan(
      'notification.fanout',
      { 'device.serial': notification.serial, 'notification.id': notification.id },
      async (span) => {
        const results = await Promise.all([
          this.deliverSse(notification),
          this.deliverFcm(notification),
        ]);
        span.setAttribute('delivered.sse', results[0]);
        span.setAttribute('delivered.fcm', results[1]);
        return results;
      },
    );

    return this.prisma.notifications.update({
      where: { id: notification.id },
      data: { deliveredSse, deliveredFcm },
    });
  }

  /** push เข้า SSE stream ให้ frontend/dashboard ที่เปิดค้างอยู่ */
  private async deliverSse(notification: Notifications): Promise<boolean> {
    // span แยกจาก FCM — สองช่องทางนี้เป็นคนละ concern, พังทางหนึ่งห้ามล้มอีกทาง
    return this.traceService.withSpan(
      'notification.sse',
      { 'device.serial': notification.serial },
      async () => {
        try {
          this.sseService.broadcast('notification', notification);
          this.metrics.recordNotificationDelivery('sse', 'success');
          return true;
        } catch (err) {
          this.logger.error(`SSE broadcast failed: ${this.msg(err)}`);
          this.metrics.recordNotificationDelivery('sse', 'error');
          this.traceService.recordOnActiveSpan(err);
          return false;
        }
      },
    );
  }

  /** broadcast ไปยัง FCM topic ของ serial (ปลุก mobile app ที่ปิดอยู่) */
  private async deliverFcm(notification: Notifications): Promise<boolean> {
    return this.traceService.withSpan(
      'notification.fcm',
      { 'device.serial': notification.serial },
      async () => {
        try {
          const result = await this.fcmService.pushToSerial(
            notification.serial,
            { title: notification.message, body: notification.detail },
            { serial: notification.serial, notificationId: notification.id },
          );
          this.metrics.recordNotificationDelivery('fcm', result.sent ? 'success' : 'error');
          return result.sent;
        } catch (err) {
          this.logger.error(`FCM push failed: ${this.msg(err)}`);
          this.metrics.recordNotificationDelivery('fcm', 'error');
          this.traceService.recordOnActiveSpan(err);
          return false;
        }
      },
    );
  }

  findBySerial(serial: string): Promise<Notifications[]> {
    return this.redis.getOrSet(bySerialKey(serial), 20, () =>
      this.prisma.notifications.findMany({
        where: { serial },
        orderBy: { createAt: 'desc' },
        take: 100,
      }),
    );
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
