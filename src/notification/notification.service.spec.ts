import { Test, TestingModule } from '@nestjs/testing';
import { NotificationService } from './notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MqttClientService } from '../mqtt/mqtt-client.service';
import { SseService } from '../sse/sse.service';
import { RabbitmqService } from '../rabbitmq/rabbitmq.service';
import { DeviceAssignmentService } from '../device/device-assignment.service';
import { ProbeResolverService } from '../probe/probe-resolver.service';
import { MetricsService } from '../observability/metrics.service';
import { createMetricsMock, observabilityTestProviders } from '../observability/testing';
import { NotFoundException } from '@nestjs/common';
import { JwtPayloadDto } from '../common/dto/payload.dto';

/** ผู้ใช้ใน tenant T1 — SUPER เห็นทุก tenant, departments 'ALL' = เห็นทั้ง tenant */
const userIn = (role: string, departments: 'ALL' | string[] = 'ALL'): JwtPayloadDto => ({
  id: 'u1',
  name: 'user',
  role,
  scope: role === 'SUPER' ? { kind: 'GLOBAL' } : { kind: 'TENANT', tenantId: 'T1', departments },
});
const OPD = { tenantId: 'T1', departmentId: 'OPD' };

describe('NotificationService', () => {
  let service: NotificationService;
  let prisma: {
    notifications: {
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
    };
    devices: { findUnique: jest.Mock; findMany: jest.Mock };
  };
  let redis: { getOrSet: jest.Mock; del: jest.Mock; delByPattern: jest.Mock };
  let mqtt: { publishNotification: jest.Mock };
  let sse: { broadcast: jest.Mock; registerUnreadCounter: jest.Mock };
  let rabbitmq: { emit: jest.Mock };
  let metrics: jest.Mocked<MetricsService>;
  let assignments: { resolveDeviceId: jest.Mock; resolveLocation: jest.Mock };
  let probes: { resolveProbeId: jest.Mock };

  const baseNotif = { id: 'n1', serial: 'SN-1', message: 'hi', detail: 'd' };

  beforeEach(async () => {
    prisma = {
      notifications: {
        create: jest.fn().mockResolvedValue(baseNotif),
        update: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve({ ...baseNotif, ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ device: OPD }),
      },
      devices: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Fridge A' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    redis = {
      getOrSet: jest.fn().mockImplementation((_key, _ttl, factory) => factory()),
      del: jest.fn().mockResolvedValue(undefined),
      delByPattern: jest.fn().mockResolvedValue(undefined),
    };
    mqtt = { publishNotification: jest.fn().mockResolvedValue(undefined) };
    sse = { broadcast: jest.fn(), registerUnreadCounter: jest.fn() };
    rabbitmq = { emit: jest.fn().mockResolvedValue(undefined) };
    metrics = createMetricsMock();
    // กล่องนี้ติดตั้งอยู่ที่จุดติดตั้ง dev-1 — notification ถูกประทับ deviceId เช่นเดียวกับ log
    assignments = {
      resolveDeviceId: jest.fn().mockResolvedValue('dev-1'),
      resolveLocation: jest.fn().mockResolvedValue(OPD),
    };
    probes = { resolveProbeId: jest.fn().mockResolvedValue('probe-1') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: MqttClientService, useValue: mqtt },
        { provide: SseService, useValue: sse },
        { provide: RabbitmqService, useValue: rabbitmq },
        { provide: DeviceAssignmentService, useValue: assignments },
        { provide: ProbeResolverService, useValue: probes },
        ...observabilityTestProviders(metrics),
      ],
    }).compile();

    service = module.get(NotificationService);
  });

  const createArg = () => prisma.notifications.create.mock.calls[0][0].data;

  describe('ผูก probe ต้นเหตุ', () => {
    it('ส่ง probe channel มา → resolve เป็น probeId แล้วเก็บทั้งสองค่า', async () => {
      await service.create({ serial: 'SN-1', message: 'PROBE/TEMP/OVER', probe: '2' });

      expect(probes.resolveProbeId).toHaveBeenCalledWith('dev-1', '2');
      expect(createArg()).toMatchObject({ probeId: 'probe-1', probe: '2' });
    });

    it('ไม่ส่ง probe มา → ถือเป็นการแจ้งเตือนระดับกล่อง ไม่ผูก probe', async () => {
      await service.create({ serial: 'SN-1', message: 'AC/OFF' });

      expect(probes.resolveProbeId).not.toHaveBeenCalled();
      expect(createArg()).toMatchObject({ probeId: null, probe: null });
    });

    it('probe เป็นช่องว่างล้วน → ถือว่าไม่ได้ส่งมา', async () => {
      await service.create({ serial: 'SN-1', message: 'AC/OFF', probe: '   ' });

      expect(probes.resolveProbeId).not.toHaveBeenCalled();
      expect(createArg().probe).toBeNull();
    });

    it('กล่องที่ยังไม่ถูกติดตั้ง → ไม่ผูก probe แต่ยังเก็บ channel ดิบ', async () => {
      assignments.resolveDeviceId.mockResolvedValue(null);

      await service.create({ serial: 'SN-1', message: 'PROBE/TEMP/OVER', probe: '2' });

      expect(probes.resolveProbeId).not.toHaveBeenCalled();
      expect(createArg()).toMatchObject({ deviceId: null, probeId: null, probe: '2' });
    });

    it('probe ติดไปใน data ของ FCM (topic ยังเป็นระดับกล่อง ไม่แตกต่อ probe)', async () => {
      prisma.notifications.create.mockResolvedValue({
        ...baseNotif,
        probe: '2',
        probeId: 'probe-1',
      });

      await service.create({ serial: 'SN-1', message: 'PROBE/TEMP/OVER', probe: '2' });

      expect(rabbitmq.emit).toHaveBeenCalledWith(
        'fcm-push',
        expect.objectContaining({
          serial: 'SN-1',
          data: expect.objectContaining({ probe: '2', probeId: 'probe-1' }),
        }),
      );
    });

    it('notification ที่ไม่มี probe ไม่ยัด key ว่างเข้า data ของ FCM', async () => {
      await service.create({ serial: 'SN-1', message: 'AC/OFF' });

      const data = rabbitmq.emit.mock.calls[0][1].data;
      expect(data).not.toHaveProperty('probe');
      expect(data).not.toHaveProperty('probeId');
    });
  });

  it('fan-out ครบ MQTT + SSE + FCM แล้ว set delivered flags = true', async () => {
    const result = await service.create({ serial: 'SN-1', message: 'hi', detail: 'd' });

    expect(mqtt.publishNotification).toHaveBeenCalledWith('dev-1', baseNotif);
    // ตำแหน่ง (tenant/department) ติดไปด้วยเพื่อให้ SSE กรองตาม scope ของ client
    // และแนบ unreadCount (ของ department นี้) เข้าไปเป็น field เพิ่มเติมบน payload เดิม
    expect(sse.broadcast).toHaveBeenCalledWith(
      'notification',
      { ...baseNotif, deviceName: 'Fridge A', unreadCount: 0 },
      OPD,
    );
    expect(rabbitmq.emit).toHaveBeenCalledWith(
      'fcm-push',
      expect.objectContaining({ serial: 'SN-1', notification: { title: 'hi', body: 'd' } }),
    );
    expect(prisma.notifications.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { deliveredSse: true, deliveredFcm: true },
    });
    expect(result.deliveredSse).toBe(true);
    expect(result.deliveredFcm).toBe(true);
  });

  it('SSE พัง แต่ FCM ยังส่ง — deliveredSse=false, deliveredFcm=true', async () => {
    sse.broadcast.mockImplementation(() => {
      throw new Error('sse down');
    });

    await service.create({ serial: 'SN-1', message: 'hi' });

    expect(rabbitmq.emit).toHaveBeenCalled();
    expect(prisma.notifications.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { deliveredSse: false, deliveredFcm: true },
    });
  });

  it('RabbitMQ publish พัง แต่ SSE ยังส่ง — deliveredFcm=false, deliveredSse=true', async () => {
    rabbitmq.emit.mockRejectedValue(new Error('broker down'));

    await service.create({ serial: 'SN-1', message: 'hi' });

    expect(sse.broadcast).toHaveBeenCalled();
    expect(prisma.notifications.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { deliveredSse: true, deliveredFcm: false },
    });
  });

  it('MQTT publish พัง ไม่บล็อก fan-out SSE/FCM', async () => {
    mqtt.publishNotification.mockRejectedValue(new Error('broker down'));
    await service.create({ serial: 'SN-1', message: 'hi' });
    expect(sse.broadcast).toHaveBeenCalled();
    expect(rabbitmq.emit).toHaveBeenCalled();
  });

  it('กล่องที่ยังไม่ถูกติดตั้ง (deviceId เป็น null) → ข้าม MQTT publish แต่ SSE/FCM ยังทำงาน', async () => {
    assignments.resolveDeviceId.mockResolvedValue(null);

    await service.create({ serial: 'SN-1', message: 'hi' });

    expect(mqtt.publishNotification).not.toHaveBeenCalled();
    expect(sse.broadcast).toHaveBeenCalled();
    expect(rabbitmq.emit).toHaveBeenCalled();
  });

  describe('classification', () => {
    it('message TEMP/OVER → category=TEMP, severity=critical persisted ตอน create', async () => {
      await service.create({ serial: 'SN-1', message: 'PROBE/TEMP/OVER' });

      expect(createArg()).toMatchObject({ category: 'TEMP', severity: 'critical' });
    });

    it('message AC/OFF → category=PLUG, severity=warning persisted ตอน create', async () => {
      await service.create({ serial: 'SN-1', message: 'AC/OFF' });

      expect(createArg()).toMatchObject({ category: 'PLUG', severity: 'warning' });
    });
  });

  describe('read state', () => {
    it('markRead: update isRead/readAt แล้ว broadcast action=read พร้อม unreadCount', async () => {
      prisma.notifications.update.mockResolvedValue({ ...baseNotif, isRead: true });
      prisma.notifications.count.mockResolvedValue(3);

      const result = await service.markRead('n1', userIn('USER', ['OPD']));

      expect(prisma.notifications.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: { isRead: true, readAt: expect.any(Date) },
      });
      expect(sse.broadcast).toHaveBeenCalledWith(
        'notification',
        { action: 'read', notificationId: 'n1', unreadCount: 3 },
        OPD,
      );
      expect(result.isRead).toBe(true);
    });

    it('markRead: การแจ้งเตือนของ tenant อื่นตอบ 404 และไม่ถูกแก้', async () => {
      prisma.notifications.findUnique.mockResolvedValue({
        device: { tenantId: 'T2', departmentId: 'OPD' },
      });

      await expect(service.markRead('n1', userIn('ADMIN', 'ALL'))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.notifications.update).not.toHaveBeenCalled();
    });

    it('markAllRead: กรองตาม scope แล้ว broadcast action=read-all ทุก department ที่ผู้ใช้เห็น', async () => {
      prisma.notifications.updateMany.mockResolvedValue({ count: 5 });
      prisma.notifications.count.mockResolvedValue(0);

      const result = await service.markAllRead(userIn('USER', ['OPD', 'ICU']));

      expect(prisma.notifications.updateMany).toHaveBeenCalledWith({
        where: {
          device: { tenantId: 'T1', departmentId: { in: ['OPD', 'ICU'] } },
          isRead: false,
        },
        data: { isRead: true, readAt: expect.any(Date) },
      });
      expect(sse.broadcast).toHaveBeenCalledTimes(2);
      expect(sse.broadcast).toHaveBeenCalledWith(
        'notification',
        { action: 'read-all', unreadCount: 0 },
        OPD,
      );
      expect(sse.broadcast).toHaveBeenCalledWith(
        'notification',
        { action: 'read-all', unreadCount: 0 },
        { tenantId: 'T1', departmentId: 'ICU' },
      );
      expect(result).toEqual({ count: 5 });
    });

    it('markAllRead: ผู้ที่เห็นทั้ง tenant broadcast ทุก department ที่มีอุปกรณ์ใน tenant', async () => {
      prisma.devices.findMany.mockResolvedValue([{ departmentId: 'OPD' }, { departmentId: 'ER' }]);

      await service.markAllRead(userIn('ADMIN', 'ALL'));

      expect(prisma.notifications.updateMany).toHaveBeenCalledWith({
        where: { device: { tenantId: 'T1' }, isRead: false },
        data: { isRead: true, readAt: expect.any(Date) },
      });
      expect(prisma.devices.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: 'T1' }, distinct: ['departmentId'] }),
      );
      expect(sse.broadcast).toHaveBeenCalledTimes(2);
    });

    it('markAllRead: GLOBAL broadcast ครั้งเดียวแบบไม่ระบุตำแหน่ง', async () => {
      await service.markAllRead(userIn('SUPER'));

      expect(prisma.notifications.updateMany).toHaveBeenCalledWith({
        where: { isRead: false },
        data: { isRead: true, readAt: expect.any(Date) },
      });
      expect(sse.broadcast).toHaveBeenCalledTimes(1);
      expect(sse.broadcast).toHaveBeenCalledWith(
        'notification',
        { action: 'read-all', unreadCount: 0 },
        { tenantId: null, departmentId: null },
      );
    });

    it('findUnreadCount: นับตาม tenant และ department ของผู้ใช้', async () => {
      prisma.notifications.count.mockResolvedValue(7);

      const count = await service.findUnreadCount(userIn('USER', ['OPD', 'ICU']));

      expect(prisma.notifications.count).toHaveBeenCalledWith({
        where: {
          device: { tenantId: 'T1', departmentId: { in: ['OPD', 'ICU'] } },
          isRead: false,
        },
      });
      expect(count).toBe(7);
    });

    it('findUnreadCount: user ที่ไม่ผูก department ใดเลยนับได้ 0 แถว (ไม่ใช่ทั้งตาราง)', async () => {
      await service.findUnreadCount(userIn('USER', []));

      expect(prisma.notifications.count).toHaveBeenCalledWith({
        where: { device: { tenantId: 'T1', departmentId: { in: [] } }, isRead: false },
      });
    });

    it('onModuleInit: register ตัวนับ unread ให้ SseService ใช้ scope เดียวกับ findUnreadCount', async () => {
      service.onModuleInit();
      const counter = sse.registerUnreadCounter.mock.calls[0][0];
      prisma.notifications.count.mockResolvedValue(4);

      await expect(counter(userIn('ADMIN', 'ALL'))).resolves.toBe(4);
      expect(prisma.notifications.count).toHaveBeenCalledWith({
        where: { device: { tenantId: 'T1' }, isRead: false },
      });
    });
  });

  describe('findBySerial', () => {
    it('กรองรายแถวตาม scope และแยก cache ตาม scope', async () => {
      await service.findBySerial('SN-1', userIn('ADMIN', 'ALL'));

      expect(prisma.notifications.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { device: { tenantId: 'T1' }, serial: 'SN-1' } }),
      );
      expect(redis.getOrSet.mock.calls[0][0]).toBe('notification:serial:SN-1:t:T1:all');
    });
  });

  describe('findCount (dashboard)', () => {
    it('นับเฉพาะ notification ย้อนหลัง 24 ชม. และคง scope ของผู้ใช้', async () => {
      prisma.notifications.findMany.mockResolvedValue([
        { message: 'SD/OFF' },
        { message: 'AC/OFF' },
        { message: 'INTERNET/OFF' },
        { message: 'X1/TEMP/OVER' },
        { message: 'X1/TEMP/LOWER' },
        { message: 'X1/1/ON' },
      ]);
      const before = Date.now();

      const result = await service.findCount(userIn('USER', ['OPD']));

      const arg = prisma.notifications.findMany.mock.calls[0][0];
      expect(arg.where.device).toEqual({ tenantId: 'T1', departmentId: { in: ['OPD'] } });
      const from: Date = arg.where.createAt.gte;
      expect(Math.abs(before - from.getTime() - 24 * 60 * 60 * 1000)).toBeLessThan(5000);
      expect(arg.select).toEqual({ message: true });
      expect(result).toEqual({ temp: 2, door: 1, internet: 1, plug: 1, sdcard: 1 });
    });
  });
});
