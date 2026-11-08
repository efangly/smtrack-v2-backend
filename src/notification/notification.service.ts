import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Notifications, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MqttClientService } from '../mqtt/mqtt-client.service';
import { SseService } from '../sse/sse.service';
import { RabbitmqService } from '../rabbitmq/rabbitmq.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { TraceService } from '../observability/trace.service';
import { MetricsService } from '../observability/metrics.service';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { DeviceLocation, canAccess, deviceWhere, scopeKey } from '../common/auth/access-scope';
import { DeviceAssignmentService } from '../device/device-assignment.service';
import { ProbeResolverService } from '../probe/probe-resolver.service';
import { NotificationQueryDto } from './dto/query-notification.dto';
import { Paginated } from '../common/pagination/paginated.dto';
import { paginationSkip, toPaginated } from '../common/pagination/paginate.util';
import { classifyNotification } from './notification-classifier.util';
import { resolveRange, TimeRange } from '../common/time/range.util';
import { FCM_PUSH_PATTERN } from '../config/rabbitmq.config';

/** แยกตาม scope เพราะผลกรองตาม tenant/department ของผู้ขอ — ล้างทั้งชุดด้วย pattern `notification:serial:<serial>:*` */
const bySerialKey = (serial: string, scope: string) => `notification:serial:${serial}:${scope}`;

export interface NotificationDashboardCount {
  temp: number;
  door: number;
  internet: number;
  plug: number;
  sdcard: number;
}

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly mqttClient: MqttClientService,
    private readonly sseService: SseService,
    private readonly rabbitmqService: RabbitmqService,
    private readonly traceService: TraceService,
    private readonly metrics: MetricsService,
    private readonly assignments: DeviceAssignmentService,
    private readonly probes: ProbeResolverService,
  ) {}

  /** ให้ SseService นับ unreadCount ตาม scope ของผู้รับแต่ละคน (scope เดียวกับ findUnreadCount) */
  onModuleInit(): void {
    this.sseService.registerUnreadCounter((user) => this.findUnreadCount(user));
  }

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
    await this.redis.delByPattern(`notification:serial:${dto.serial}:*`);

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
          // ส่ง tenant/department ไปด้วยเพื่อให้ SseService กรองตาม scope ของ client ได้
          const location = await this.assignments.resolveLocation(notification.serial);
          // แนบ unreadCount (ของ department นี้ — SseService นับใหม่ตาม scope ของผู้รับ) ไปด้วย เป็น field เพิ่มเติมบน payload เดิม
          // (ไม่ทำลาย consumer เดิมที่อ่านแค่ field ของ Notifications ตรง ๆ) เพื่อให้ dashboard
          // อัปเดตตัวเลขแจ้งเตือนใหม่แบบ real-time โดยไม่ต้องยิง fetch แยก
          const unreadCount = await this.countUnread(location);
          // แนบชื่อ device (Devices.name) ไปด้วยเพื่อให้ frontend แสดงตอนมีการแจ้งเตือนได้ทันที
          const device = await this.prisma.devices.findUnique({
            where: { serial: notification.serial },
            select: { name: true },
          });
          this.sseService.broadcast(
            'notification',
            { ...notification, deviceName: device?.name ?? null, unreadCount },
            location,
          );
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

  /** publish ข้อมูล push notification ผ่าน RabbitMQ ไปยัง FCM service แยกต่างหาก (ปลุก mobile app ที่ปิดอยู่) */
  private async deliverFcm(notification: Notifications): Promise<boolean> {
    return this.traceService.withSpan(
      'notification.fcm',
      { 'device.serial': notification.serial },
      async () => {
        try {
          await this.rabbitmqService.emit(FCM_PUSH_PATTERN, {
            serial: notification.serial,
            notification: { title: notification.message, body: notification.detail },
            data: {
              serial: notification.serial,
              notificationId: notification.id,
              // topic เป็นระดับกล่อง (device_{serial}) ให้ FCM service ปลายทางสร้างเอง — probe ไปเป็น data
              // ให้ mobile กรอง/ชี้จุดเองว่าเป็น probe ไหน ไม่แตก topic ต่อ probe
              ...(notification.probe ? { probe: notification.probe } : {}),
              ...(notification.probeId ? { probeId: notification.probeId } : {}),
            },
          });
          this.metrics.recordNotificationDelivery('fcm', 'success');
          return true;
        } catch (err) {
          this.logger.error(`FCM publish via RabbitMQ failed: ${this.msg(err)}`);
          this.metrics.recordNotificationDelivery('fcm', 'error');
          this.traceService.recordOnActiveSpan(err);
          return false;
        }
      },
    );
  }

  /** กล่องย้ายข้าม tenant ได้ จึงกรองรายแถวตามจุดติดตั้งที่ประทับไว้ ไม่ใช่ตามที่กล่องอยู่ตอนนี้ */
  findBySerial(serial: string, user: JwtPayloadDto): Promise<Notifications[]> {
    const { conditions } = this.findCondition(user);
    return this.redis.getOrSet(bySerialKey(serial, scopeKey(user.scope)), 20, () =>
      this.prisma.notifications.findMany({
        where: { ...conditions, serial },
        orderBy: { createAt: 'desc' },
        take: 100,
      }),
    );
  }

  /** paginated/filtered list — กรองตาม scope (tenant/department) ของผู้ใช้ */
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

  /** สรุป dashboard เฉพาะ notification ย้อนหลัง 24 ชม. (rolling window) — ไม่นับทั้ง DB */
  async findCount(user: JwtPayloadDto): Promise<NotificationDashboardCount> {
    const { conditions, key } = this.findCondition(user);
    // cache เฉพาะผลที่นับเสร็จแล้ว (5 ตัวเลข) แทนการ cache แถวทั้งหมด; window เลื่อนตามเวลา + TTL สั้น
    return this.redis.getOrSet(`count-${key}`, 30, async () => {
      const { from } = resolveRange(TimeRange.DAY);
      const notification = await this.prisma.notifications.findMany({
        where: { ...conditions, createAt: { gte: from } },
        select: { message: true },
      });

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
    });
  }

  /** unread count แบบ persistent (ต่างจาก findCount ที่นับตาม type/message) — กรองตาม scope เหมือนกัน */
  findUnreadCount(user: JwtPayloadDto): Promise<number> {
    const { conditions } = this.findCondition(user);
    return this.prisma.notifications.count({ where: { ...conditions, isRead: false } });
  }

  /**
   * นับ unread ของจุดที่เกิด event ใช้ตอน broadcast unreadCount สด ๆ ผ่าน SSE — ค่านี้ถึงมือเฉพาะ GLOBAL
   * (ผู้รับคนอื่นได้ค่าที่นับใหม่ตาม scope ตัวเองใน SseService) จึงไม่รู้ตำแหน่ง = นับทั้งหมด
   */
  private countUnread(location: DeviceLocation): Promise<number> {
    if (location.tenantId === null && location.departmentId === null) {
      return this.prisma.notifications.count({ where: { isRead: false } });
    }
    return this.prisma.notifications.count({
      where: {
        isRead: false,
        device: {
          tenantId: location.tenantId,
          ...(location.departmentId !== null ? { departmentId: location.departmentId } : {}),
        },
      },
    });
  }

  async markRead(id: string, user: JwtPayloadDto): Promise<Notifications> {
    // ตำแหน่งของการแจ้งเตือน = จุดติดตั้งที่ประทับไว้ตอนเกิด — นอก scope ตอบ 404 เหมือนไม่มีอยู่จริง
    const existing = await this.prisma.notifications.findUnique({
      where: { id },
      select: { device: { select: { tenantId: true, departmentId: true } } },
    });
    const location: DeviceLocation = existing?.device ?? { tenantId: null, departmentId: null };
    if (!existing || !canAccess(user.scope, location)) {
      throw new NotFoundException(`Notification ${id} not found`);
    }
    const notification = await this.prisma.notifications.update({
      where: { id },
      data: { isRead: true, readAt: new Date() },
    });
    try {
      const unreadCount = await this.countUnread(location);
      this.sseService.broadcast(
        'notification',
        { action: 'read', notificationId: id, unreadCount },
        location,
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
      const unreadCount = await this.findUnreadCount(user);
      for (const location of await this.locationsIn(user)) {
        this.sseService.broadcast('notification', { action: 'read-all', unreadCount }, location);
      }
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
   * "อ่านทั้งหมด" กระทบทุก department ที่ผู้ใช้เห็น — SSE กรองทีละตำแหน่ง จึงส่งหนึ่ง event ต่อ department
   * ให้ client ของแต่ละ department ได้รับ (GLOBAL ส่งครั้งเดียวแบบไม่ระบุตำแหน่ง ซึ่งเห็นได้เฉพาะ GLOBAL)
   */
  private async locationsIn(user: JwtPayloadDto): Promise<DeviceLocation[]> {
    const scope = user.scope;
    if (scope.kind === 'GLOBAL') return [{ tenantId: null, departmentId: null }];
    if (scope.departments !== 'ALL') {
      return scope.departments.map((departmentId) => ({ tenantId: scope.tenantId, departmentId }));
    }
    const rows = await this.prisma.devices.findMany({
      where: { tenantId: scope.tenantId },
      distinct: ['departmentId'],
      select: { departmentId: true },
    });
    return rows.map(({ departmentId }) => ({ tenantId: scope.tenantId, departmentId }));
  }

  /** กรองตาม scope ของผู้ใช้ — การแจ้งเตือนที่ไม่ผูกจุดติดตั้ง (deviceId null) เห็นได้เฉพาะ GLOBAL */
  private findCondition(user: JwtPayloadDto): {
    conditions: Prisma.NotificationsWhereInput | undefined;
    key: string;
  } {
    if (user.scope.kind === 'GLOBAL') return { conditions: undefined, key: 'notification' };
    return {
      conditions: { device: deviceWhere(user.scope) },
      key: `notification:${scopeKey(user.scope)}`,
    };
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
