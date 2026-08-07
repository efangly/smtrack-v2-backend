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
import { ProbeResolverService } from '../probe/probe-resolver.service';
import { NotificationQueryDto } from './dto/query-notification.dto';
import { Paginated } from '../common/pagination/paginated.dto';
import { paginationSkip, toPaginated } from '../common/pagination/paginate.util';
import { classifyNotification } from './notification-classifier.util';

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
    private readonly probes: ProbeResolverService,
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

    // ผูก probe ต้นเหตุถ้าอุปกรณ์บอกมา — ไม่บอกถือว่าเป็นการแจ้งเตือนระดับกล่อง (ไฟดับ/เน็ตหลุด)
    // ใช้ resolver ตัวเดียวกับ ingest จึง auto-provision probe ที่ยังไม่มีให้เหมือนกัน
    const channel = dto.probe?.trim() || null;
    const probeId =
      deviceId && channel ? await this.probes.resolveProbeId(deviceId, channel) : null;

    const { category, severity } = classifyNotification(dto.message);
    const notification = await this.prisma.notifications.create({
      data: {
        serial: dto.serial,
        deviceId,
        probeId,
        probe: channel,
        message: dto.message,
        detail: dto.detail ?? '',
        category,
        severity,
      },
    });
    await this.redis.del(bySerialKey(dto.serial));

    // publish ผ่าน MQTT topic notification/{deviceId} (log/notify เดินผ่าน MQTT เท่านั้น)
    // deviceId เป็น null ได้ถ้ากล่องยังไม่ถูกติดตั้งที่ไหน — ไม่มี deviceId ก็ build topic ไม่ได้ ข้ามไป
    if (deviceId) {
      try {
        await this.mqttClient.publishNotification(deviceId, notification);
      } catch (err) {
        this.logger.error(`MQTT publish notification failed: ${this.msg(err)}`);
      }
    } else {
      this.logger.warn(
        `ข้าม MQTT publish notification: serial ${dto.serial} ยังไม่ถูกติดตั้งที่จุดใด (deviceId เป็น null)`,
      );
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
          // แนบ unreadCount (ของ ward นี้) ไปด้วย เป็น field เพิ่มเติมบน payload เดิม
          // (ไม่ทำลาย consumer เดิมที่อ่านแค่ field ของ Notifications ตรง ๆ) เพื่อให้ dashboard
          // อัปเดตตัวเลขแจ้งเตือนใหม่แบบ real-time โดยไม่ต้องยิง fetch แยก
          const unreadCount = await this.countUnread(ward);
          this.sseService.broadcast('notification', { ...notification, unreadCount }, ward);
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
            {
              serial: notification.serial,
              notificationId: notification.id,
              // topic ยังเป็นระดับกล่อง (device_{serial}) ตามเดิม — probe ไปเป็น data
              // ให้ mobile กรอง/ชี้จุดเองว่าเป็น probe ไหน ไม่แตก topic ต่อ probe
              ...(notification.probe ? { probe: notification.probe } : {}),
              ...(notification.probeId ? { probeId: notification.probeId } : {}),
            },
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
    query: NotificationQueryDto,
    user: JwtPayloadDto,
  ): Promise<Paginated<Notifications>> {
    const { conditions, key } = this.findCondition(user);
    const cacheKey = `${key}:${query.page ?? 1}:${query.limit ?? 20}`;
    const take = query.limit ?? 20;
    const skip = paginationSkip(query);

    let where = conditions;
    if (query.category || query.severity) {
      // filter แบบ structured ผ่านคอลัมน์ที่ index ไว้ (deviceId,isRead) เร็วกว่า message.contains
      where = {
        ...where,
        ...(query.category ? { category: query.category.toUpperCase() } : {}),
        ...(query.severity ? { severity: query.severity.toLowerCase() } : {}),
      };
      const [data, total] = await Promise.all([
        this.prisma.notifications.findMany({ take, skip, where, orderBy: { createAt: 'desc' } }),
        this.prisma.notifications.count({ where }),
      ]);
      return toPaginated(data, total, query);
    }
    if (query.filter) {
      const contains = this.filterToMessageContains(query.filter);
      where = { ...where, message: { contains } };
      const [data, total] = await Promise.all([
        this.prisma.notifications.findMany({ take, skip, where, orderBy: { createAt: 'desc' } }),
        this.prisma.notifications.count({ where }),
      ]);
      return toPaginated(data, total, query);
    }

    // เก็บ cache เป็น {data, total} ธรรมดา ไม่ใช่ instance ของ Paginated เพราะ getOrSet
    // เขียน/อ่านผ่าน JSON.stringify/parse ทำให้ instanceof เช็คไม่ผ่านตอน cache hit
    const { data, total } = await this.redis.getOrSet(cacheKey, 15, async () => {
      const [data, total] = await Promise.all([
        this.prisma.notifications.findMany({ take, skip, where, orderBy: { createAt: 'desc' } }),
        this.prisma.notifications.count({ where }),
      ]);
      return { data, total };
    });
    return toPaginated(data, total, query);
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
    // group ด้วย classifier ตัวเดียวกับที่ persist ตอน create() — แหล่งความจริงเดียว
    // (เดิม parse message แยกกันคนละจุด ทำให้ logic ดริฟท์ได้)
    for (const n of notification) {
      const { category } = classifyNotification(n.message);
      switch (category) {
        case 'SDCARD':
          counts.sdcard++;
          break;
        case 'PLUG':
          counts.plug++;
          break;
        case 'INTERNET':
          counts.internet++;
          break;
        case 'TEMP':
          counts.temp++;
          break;
        case 'DOOR':
          counts.door++;
          break;
        default:
          break;
      }
    }
    return counts;
  }

  /** unread count แบบ persistent (ต่างจาก findCount ที่นับตาม type/message) — ward-scoped เหมือนกัน */
  findUnreadCount(user: JwtPayloadDto): Promise<number> {
    const { conditions } = this.findCondition(user);
    return this.prisma.notifications.count({ where: { ...conditions, isRead: false } });
  }

  /** นับ unread ของ ward เดียว ใช้ตอน broadcast unreadCount สด ๆ ผ่าน SSE (ward=null = นับรวมทุก ward) */
  private countUnread(ward: string | null): Promise<number> {
    return this.prisma.notifications.count({
      where: ward ? { isRead: false, device: { ward } } : { isRead: false },
    });
  }

  async markRead(id: string): Promise<Notifications> {
    const notification = await this.prisma.notifications.update({
      where: { id },
      data: { isRead: true, readAt: new Date() },
    });
    try {
      const ward = await this.assignments.resolveWard(notification.serial);
      const unreadCount = await this.countUnread(ward);
      this.sseService.broadcast(
        'notification',
        { action: 'read', notificationId: id, unreadCount },
        ward,
      );
    } catch (err) {
      this.logger.warn(`broadcast notification.read ล้มเหลว: ${this.msg(err)}`);
    }
    return notification;
  }

  async markAllRead(user: JwtPayloadDto): Promise<{ count: number }> {
    const { conditions } = this.findCondition(user);
    const result = await this.prisma.notifications.updateMany({
      where: { ...conditions, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    try {
      const ward = user.wardId ?? null;
      const unreadCount = await this.findUnreadCount(user);
      this.sseService.broadcast('notification', { action: 'read-all', unreadCount }, ward);
    } catch (err) {
      this.logger.warn(`broadcast notification.read-all ล้มเหลว: ${this.msg(err)}`);
    }
    return { count: result.count };
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
