import { Injectable, Logger } from '@nestjs/common';
import { Notifications, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MqttClientService } from '../mqtt/mqtt-client.service';
import { SseService } from '../sse/sse.service';
import { FcmService } from '../fcm/fcm.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { TraceService } from '../observability/trace.service';
import { MetricsService } from '../observability/metrics.service';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { DeviceAssignmentService } from '../device/device-assignment.service';

const bySerialKey = (serial: string) => `notification:${serial}`;

export interface NotificationDashboardCount {
  temp: number;
  door: number;
  internet: number;
  plug: number;
  sdcard: number;
}

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
    private readonly assignments: DeviceAssignmentService,
  ) {}

  /**
   * สร้างการแจ้งเตือน แล้ว fan-out ผ่าน MQTT + SSE + FCM
   * - SSE / FCM เป็นคนละ concern กัน wrap try/catch แยก ไม่ให้ทางหนึ่งพังบล็อกอีกทาง
   * - อัปเดต deliveredSse / deliveredFcm ตามผลจริง
   */
  async create(dto: CreateNotificationDto): Promise<Notifications> {
    // ประทับจุดติดตั้ง ณ เวลาที่แจ้งเตือนเกิด ด้วยเหตุผลเดียวกับ LogDays.deviceId
    // (null ได้ ถ้ากล่องยังไม่ถูกติดตั้งที่ไหน)
    const deviceId = await this.assignments.resolveDeviceId(dto.serial);

    const notification = await this.prisma.notifications.create({
      data: {
        serial: dto.serial,
        deviceId,
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
          // ส่ง ward ไปด้วยเพื่อให้ SseService กรองให้ client ที่ถูก scope ตาม ward ได้
          const ward = await this.assignments.resolveWard(notification.serial);
          this.sseService.broadcast('notification', notification, ward);
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

  /** paginated/filtered list — role scoping ตาม ward เท่านั้น (hospital ตัดออกแล้วใน v2 schema) */
  async findAll(
    filter: string | undefined,
    page: number,
    perpage: number,
    user: JwtPayloadDto,
  ): Promise<Notifications[]> {
    const { conditions, key } = this.findCondition(user);
    const cacheKey = `${key}:${page}:${perpage}`;

    let where = conditions;
    if (filter) {
      const contains = this.filterToMessageContains(filter);
      where = { ...where, message: { contains } };
      return this.prisma.notifications.findMany({
        take: perpage,
        skip: (page - 1) * perpage,
        where,
        orderBy: { createAt: 'desc' },
      });
    }

    return this.redis.getOrSet(cacheKey, 15, () =>
      this.prisma.notifications.findMany({
        take: perpage,
        skip: (page - 1) * perpage,
        where,
        orderBy: { createAt: 'desc' },
      }),
    );
  }

  async findCount(user: JwtPayloadDto): Promise<NotificationDashboardCount> {
    const { conditions, key } = this.findCondition(user);
    const notification = await this.redis.getOrSet(`count-${key}`, 30, () =>
      this.prisma.notifications.findMany({ where: conditions, orderBy: { createAt: 'desc' } }),
    );

    const counts: NotificationDashboardCount = {
      temp: 0,
      door: 0,
      internet: 0,
      plug: 0,
      sdcard: 0,
    };
    for (const n of notification) {
      const msgType = n.message.split('/');
      switch (msgType[0]) {
        case 'SD':
          if (msgType[1] === 'OFF') counts.sdcard++;
          break;
        case 'AC':
          if (msgType[1] === 'OFF') counts.plug++;
          break;
        case 'INTERNET':
          if (msgType[1] === 'OFF') counts.internet++;
          break;
        default:
          if (msgType[1] === 'TEMP') {
            if (msgType[2] === 'OVER' || msgType[2] === 'LOWER') counts.temp++;
          } else if (msgType[2] === 'ON') {
            counts.door++;
          }
      }
    }
    return counts;
  }

  update(id: string, dto: UpdateNotificationDto): Promise<Notifications> {
    return this.prisma.notifications.update({ where: { id }, data: dto });
  }

  remove(id: string): Promise<Notifications> {
    return this.prisma.notifications.delete({ where: { id } });
  }

  /**
   * role-based scoping — เดิม (legacy) มี branch ตาม hospital ด้วย แต่ v2 ตัด field hospital
   * ออกจาก schema แล้ว (migration remove_hospital_and_notification_tokens) จึง scope ได้แค่ ward
   */
  private findCondition(user: JwtPayloadDto): {
    conditions: Prisma.NotificationsWhereInput | undefined;
    key: string;
  } {
    switch (user.role) {
      case 'USER':
      case 'LEGACY_USER':
        return {
          conditions: { device: { ward: user.wardId } },
          key: `notification:${user.wardId}`,
        };
      default:
        return { conditions: undefined, key: 'notification' };
    }
  }

  private filterToMessageContains(filter: string): string {
    switch (filter) {
      case 'door':
        return 'DOOR';
      case 'temp':
        return 'TEMP';
      case 'internet':
        return 'INTERNET';
      case 'plug':
        return 'AC';
      case 'sdcard':
        return 'SD';
      case 'report':
        return 'REPORT';
      default:
        return filter;
    }
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
