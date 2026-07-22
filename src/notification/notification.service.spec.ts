import { Test, TestingModule } from '@nestjs/testing';
import { NotificationService } from './notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MqttClientService } from '../mqtt/mqtt-client.service';
import { SseService } from '../sse/sse.service';
import { FcmService } from '../fcm/fcm.service';
import { MetricsService } from '../observability/metrics.service';
import { createMetricsMock, observabilityTestProviders } from '../observability/testing';

describe('NotificationService', () => {
  let service: NotificationService;
  let prisma: { notifications: { create: jest.Mock; update: jest.Mock } };
  let redis: { getOrSet: jest.Mock; del: jest.Mock };
  let mqtt: { publishNotification: jest.Mock };
  let sse: { broadcast: jest.Mock };
  let fcm: { pushToSerial: jest.Mock };
  let metrics: jest.Mocked<MetricsService>;

  const baseNotif = { id: 'n1', serial: 'SN-1', message: 'hi', detail: 'd' };

  beforeEach(async () => {
    prisma = {
      notifications: {
        create: jest.fn().mockResolvedValue(baseNotif),
        update: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve({ ...baseNotif, ...data })),
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: MqttClientService, useValue: mqtt },
        { provide: SseService, useValue: sse },
        { provide: FcmService, useValue: fcm },
        ...observabilityTestProviders(metrics),
      ],
    }).compile();

    service = module.get(NotificationService);
  });

  it('fan-out ครบ MQTT + SSE + FCM แล้ว set delivered flags = true', async () => {
    const result = await service.create({ serial: 'SN-1', message: 'hi', detail: 'd' });

    expect(mqtt.publishNotification).toHaveBeenCalledWith('SN-1', baseNotif);
    expect(sse.broadcast).toHaveBeenCalledWith('notification', baseNotif);
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
});
