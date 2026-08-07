import { Test, TestingModule } from '@nestjs/testing';
import { NotificationService } from './notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MqttClientService } from '../mqtt/mqtt-client.service';
import { SseService } from '../sse/sse.service';
import { FcmService } from '../fcm/fcm.service';
import { DeviceAssignmentService } from '../device/device-assignment.service';
import { ProbeResolverService } from '../probe/probe-resolver.service';
import { MetricsService } from '../observability/metrics.service';
import { createMetricsMock, observabilityTestProviders } from '../observability/testing';

describe('NotificationService', () => {
  let service: NotificationService;
  let prisma: {
    notifications: {
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
  };
  let redis: { getOrSet: jest.Mock; del: jest.Mock };
  let mqtt: { publishNotification: jest.Mock };
  let sse: { broadcast: jest.Mock };
  let fcm: { pushToSerial: jest.Mock };
  let metrics: jest.Mocked<MetricsService>;
  let assignments: { resolveDeviceId: jest.Mock; resolveWard: jest.Mock };
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
      },
    };
    redis = {
      getOrSet: jest.fn().mockImplementation((_key, _ttl, factory) => factory()),
      del: jest.fn().mockResolvedValue(undefined),
    };
    mqtt = { publishNotification: jest.fn().mockResolvedValue(undefined) };
    sse = { broadcast: jest.fn() };
    fcm = {
      pushToSerial: jest.fn().mockResolvedValue({ topic: 'device_SN-1', sent: true }),
    };
    metrics = createMetricsMock();
    // กล่องนี้ติดตั้งอยู่ที่จุดติดตั้ง dev-1 — notification ถูกประทับ deviceId เช่นเดียวกับ log
    assignments = {
      resolveDeviceId: jest.fn().mockResolvedValue('dev-1'),
      resolveWard: jest.fn().mockResolvedValue('OPD'),
    };
    probes = { resolveProbeId: jest.fn().mockResolvedValue('probe-1') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: MqttClientService, useValue: mqtt },
        { provide: SseService, useValue: sse },
        { provide: FcmService, useValue: fcm },
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

      expect(fcm.pushToSerial).toHaveBeenCalledWith(
        'SN-1',
        expect.anything(),
        expect.objectContaining({ probe: '2', probeId: 'probe-1' }),
      );
    });

    it('notification ที่ไม่มี probe ไม่ยัด key ว่างเข้า data ของ FCM', async () => {
      await service.create({ serial: 'SN-1', message: 'AC/OFF' });

      const data = fcm.pushToSerial.mock.calls[0][2];
      expect(data).not.toHaveProperty('probe');
      expect(data).not.toHaveProperty('probeId');
    });
  });

  it('fan-out ครบ MQTT + SSE + FCM แล้ว set delivered flags = true', async () => {
    const result = await service.create({ serial: 'SN-1', message: 'hi', detail: 'd' });

    expect(mqtt.publishNotification).toHaveBeenCalledWith('dev-1', baseNotif);
    // ward ติดไปด้วยเพื่อให้ SSE กรองให้ client ที่ถูก scope ตาม ward
    // และแนบ unreadCount (ของ ward นี้) เข้าไปเป็น field เพิ่มเติมบน payload เดิม
    expect(sse.broadcast).toHaveBeenCalledWith(
      'notification',
      { ...baseNotif, unreadCount: 0 },
      'OPD',
    );
    expect(fcm.pushToSerial).toHaveBeenCalled();
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

    expect(fcm.pushToSerial).toHaveBeenCalled();
    expect(prisma.notifications.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { deliveredSse: false, deliveredFcm: true },
    });
  });

  it('FCM พัง แต่ SSE ยังส่ง — deliveredFcm=false, deliveredSse=true', async () => {
    fcm.pushToSerial.mockRejectedValue(new Error('fcm down'));

    await service.create({ serial: 'SN-1', message: 'hi' });

    expect(sse.broadcast).toHaveBeenCalled();
    expect(prisma.notifications.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { deliveredSse: true, deliveredFcm: false },
    });
  });

  it('FCM broadcast ไม่สำเร็จ (sent=false) → deliveredFcm=false', async () => {
    fcm.pushToSerial.mockResolvedValue({ topic: 'device_SN-1', sent: false });
    await service.create({ serial: 'SN-1', message: 'hi' });
    expect(prisma.notifications.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { deliveredSse: true, deliveredFcm: false },
    });
  });

  it('MQTT publish พัง ไม่บล็อก fan-out SSE/FCM', async () => {
    mqtt.publishNotification.mockRejectedValue(new Error('broker down'));
    await service.create({ serial: 'SN-1', message: 'hi' });
    expect(sse.broadcast).toHaveBeenCalled();
    expect(fcm.pushToSerial).toHaveBeenCalled();
  });

  it('กล่องที่ยังไม่ถูกติดตั้ง (deviceId เป็น null) → ข้าม MQTT publish แต่ SSE/FCM ยังทำงาน', async () => {
    assignments.resolveDeviceId.mockResolvedValue(null);

    await service.create({ serial: 'SN-1', message: 'hi' });

    expect(mqtt.publishNotification).not.toHaveBeenCalled();
    expect(sse.broadcast).toHaveBeenCalled();
    expect(fcm.pushToSerial).toHaveBeenCalled();
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

      const result = await service.markRead('n1');

      expect(prisma.notifications.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: { isRead: true, readAt: expect.any(Date) },
      });
      expect(sse.broadcast).toHaveBeenCalledWith(
        'notification',
        { action: 'read', notificationId: 'n1', unreadCount: 3 },
        'OPD',
      );
      expect(result.isRead).toBe(true);
    });

    it('markAllRead: updateMany ward-scoped แล้ว broadcast action=read-all', async () => {
      prisma.notifications.updateMany.mockResolvedValue({ count: 5 });
      prisma.notifications.count.mockResolvedValue(0);

      const result = await service.markAllRead({
        id: 'u1',
        name: 'user',
        role: 'USER',
        wardId: 'OPD',
      } as never);

      expect(prisma.notifications.updateMany).toHaveBeenCalledWith({
        where: { device: { ward: 'OPD' }, isRead: false },
        data: { isRead: true, readAt: expect.any(Date) },
      });
      expect(sse.broadcast).toHaveBeenCalledWith(
        'notification',
        { action: 'read-all', unreadCount: 0 },
        'OPD',
      );
      expect(result).toEqual({ count: 5 });
    });

    it('findUnreadCount: นับแบบ ward-scoped ตาม role ผู้ใช้', async () => {
      prisma.notifications.count.mockResolvedValue(7);

      const count = await service.findUnreadCount({
        id: 'u1',
        name: 'user',
        role: 'USER',
        wardId: 'OPD',
      } as never);

      expect(prisma.notifications.count).toHaveBeenCalledWith({
        where: { device: { ward: 'OPD' }, isRead: false },
      });
      expect(count).toBe(7);
    });
  });
});
