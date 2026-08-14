import { Controller, INestApplication, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Ctx, EventPattern, Payload, RmqContext, Transport } from '@nestjs/microservices';
import * as amqplib from 'amqplib';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { FCM_PUSH_PATTERN } from '../src/config/rabbitmq.config';
import { API_PREFIX, createTestApp, unwrap, waitFor } from './utils/create-test-app';
import { bearerDevice } from './utils/auth';
import {
  E2E_PREFIX,
  buildDevices,
  cleanupByPrefix,
  seedDevice,
  serialFor,
} from './fixtures/seed-data';

/**
 * ⚠️ ต้องตั้งก่อน createTestApp() เพราะ configuration.ts อ่าน process.env ตอน ConfigModule init
 *
 * ห้ามให้เทสไปแย่ง consume `fcm_notification_queue` ตัวจริง — ใช้ queue แยกชื่อเฉพาะของเทส
 * เหมือนแนวทางของ test/rmq-consumer.e2e-spec.ts
 */
const E2E_FCM_QUEUE = 'fcm_notification_queue_e2e';
process.env.RABBITMQ_FCM_QUEUE = E2E_FCM_QUEUE;

interface CapturedFcmPush {
  serial: string;
  notification: { title: string; body: string };
  data: Record<string, string>;
}

/** consumer จำลองฝั่ง FCM service — เก็บทุก message ที่ publish เข้ามาไว้ตรวจสอบ */
@Controller()
class FcmPushCaptureController {
  static readonly received: CapturedFcmPush[] = [];

  @EventPattern(FCM_PUSH_PATTERN)
  handle(@Payload() data: CapturedFcmPush, @Ctx() context: RmqContext): void {
    FcmPushCaptureController.received.push(data);
    context.getChannelRef().ack(context.getMessage());
  }
}

@Module({ controllers: [FcmPushCaptureController] })
class FcmPushCaptureModule {}

describe('RabbitMQ FCM publish (e2e, real broker)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let consumerApp: INestApplication;

  const serial = serialFor(E2E_PREFIX, 1);

  beforeAll(async () => {
    // realRabbitmq: true → ปล่อยให้ RabbitmqService ต่อ broker จริงแทนการ mock (ต่างจากชุด e2e อื่น)
    const ctx = await createTestApp({ realRabbitmq: true });
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);

    await cleanupByPrefix(prisma, E2E_PREFIX);
    await seedDevice(prisma, buildDevices(E2E_PREFIX)[0]);

    // เปิด microservice แยกต่างหากจำลองฝั่ง FCM service เพื่อดักอ่าน queue ที่ backend publish เข้ามาจริง
    consumerApp = await NestFactory.create(FcmPushCaptureModule, { logger: false });
    const config = ctx.moduleRef.get(ConfigService);
    consumerApp.connectMicroservice({
      transport: Transport.RMQ,
      options: {
        urls: [config.get<string>('rabbitmqUrl') as string],
        queue: E2E_FCM_QUEUE,
        queueOptions: { durable: true },
        noAck: false,
      },
    });
    await consumerApp.startAllMicroservices();
  });

  afterAll(async () => {
    await consumerApp?.close();
    await app?.close();
    await cleanupByPrefix(prisma, E2E_PREFIX);

    // ลบ queue ของเทสทิ้ง ไม่ให้ค้างสะสมบน broker ที่ใช้ร่วมกัน
    const conn = await amqplib.connect(process.env.RABBITMQ_URL as string);
    const ch = await conn.createChannel();
    await ch.deleteQueue(E2E_FCM_QUEUE).catch(() => undefined);
    await ch.close();
    await conn.close();
  });

  beforeEach(() => {
    FcmPushCaptureController.received.length = 0;
  });

  it('POST /notifications publish message ไปถึง queue จริงด้วย pattern fcm-push', async () => {
    const res = await request(app.getHttpServer())
      .post(`${API_PREFIX}/notifications`)
      .set('Authorization', bearerDevice(serial))
      .send({ serial, message: 'Temperature high', detail: 'temp 8.5C exceeded threshold' });

    expect(res.status).toBe(201);
    const created = unwrap(res.body);

    await waitFor(async () => FcmPushCaptureController.received.length > 0, {
      retries: 60,
      intervalMs: 250,
    });

    expect(FcmPushCaptureController.received).toHaveLength(1);
    const [received] = FcmPushCaptureController.received;
    expect(received.serial).toBe(serial);
    expect(received.notification).toEqual({
      title: 'Temperature high',
      body: 'temp 8.5C exceeded threshold',
    });
    expect(received.data.notificationId).toBe(created.id);
    expect(received.data.serial).toBe(serial);

    // deliveredFcm=true ต้องคู่กับ message ที่ไปถึง queue จริง ไม่ใช่แค่ HTTP 201
    expect(created.deliveredFcm).toBe(true);
  });
});
