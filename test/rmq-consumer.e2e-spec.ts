import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy, ClientProxyFactory, Transport } from '@nestjs/microservices';
import * as amqplib from 'amqplib';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildRmqLogOptions } from '../src/config/rabbitmq.config';
import { createTestApp, waitFor } from './utils/create-test-app';
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
 * ห้ามให้เทสไปแย่ง consume `log_queue` ตัวจริง — broker เป็นเครื่องที่ใช้ร่วมกันและมี
 * consumer ของแอปที่รันอยู่จริงเกาะอยู่แล้ว ถ้าเทสเปิด consumer ซ้ำบน queue เดียวกัน
 * RabbitMQ จะ round-robin ข้อความจริงจาก smtrack-log-service มาเข้าเทสแบบสุ่ม
 * (ทั้งเทสพังแบบ flaky และข้อความจริงหาย) จึงใช้ queue แยกชื่อเฉพาะของเทส
 */
const E2E_QUEUE = 'log_queue_e2e';
process.env.RABBITMQ_LOG_QUEUE = E2E_QUEUE;

describe('RabbitMQ consumer (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let client: ClientProxy;

  const serial = serialFor(E2E_PREFIX, 1);

  /** รอจน queue ว่าง — ยืนยันว่าข้อความถูก ack/nack ออกไปแล้ว ไม่ได้ค้าง unacked */
  const queueIsDrained = async (): Promise<boolean> => {
    const conn = await amqplib.connect(process.env.RABBITMQ_URL as string);
    try {
      const ch = await conn.createChannel();
      const { messageCount } = await ch.checkQueue(E2E_QUEUE);
      await ch.close();
      return messageCount === 0;
    } finally {
      await conn.close();
    }
  };

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);

    await cleanupByPrefix(prisma, E2E_PREFIX);
    await seedDevice(prisma, buildDevices(E2E_PREFIX)[0]);

    // createTestApp ไม่ต่อ microservice ให้ (ชุดอื่นเทสผ่าน HTTP) — ชุดนี้ต้องเดินผ่าน
    // transport จริง จึง attach เองด้วย options ตัวเดียวกับ src/main.ts
    const config = ctx.moduleRef.get(ConfigService);
    app.connectMicroservice(buildRmqLogOptions(config), { inheritAppConfig: true });
    await app.startAllMicroservices();

    // ฝั่ง producer ห้ามใช้ buildRmqLogOptions ตรง ๆ — `noAck: false` เป็นค่าของฝั่ง consumer
    // ClientRMQ เอาไปใช้กับ reply queue (amq.rabbitmq.reply-to) ด้วย ซึ่ง broker บังคับว่า
    // ต้อง noAck เท่านั้น ไม่งั้นตอบ 406 PRECONDITION_FAILED แล้ว reconnect วน
    client = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [config.get<string>('rabbitmqUrl') as string],
        queue: E2E_QUEUE,
        queueOptions: { durable: true },
      },
    });
    await client.connect();
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
    await cleanupByPrefix(prisma, E2E_PREFIX);

    // ลบ queue ของเทสทิ้ง ไม่ให้ค้างสะสมบน broker ที่ใช้ร่วมกัน
    const conn = await amqplib.connect(process.env.RABBITMQ_URL as string);
    const ch = await conn.createChannel();
    await ch.deleteQueue(E2E_QUEUE);
    await ch.close();
    await conn.close();
  });

  it('device-log จาก RabbitMQ จริงถูกเขียนลง LogDays ผ่าน TelemetryService.ingest', async () => {
    client.emit('device-log', {
      // field ของ legacy ที่ v2 ไม่มี — ต้องถูก whitelist ตัดทิ้ง ไม่ใช่ทำให้ทั้งข้อความตก
      id: 'legacy-uuid',
      createAt: '2026-08-01T00:00:00.000Z',
      serial,
      temp: 4.2,
      tempDisplay: 4.2,
      humidity: 55,
      door1: true,
      plug: true,
      internet: true,
      probe: '1',
      // float มาจากต้นทางที่ประกาศ @IsNumber — ต้องถูกปัดเป็น int (เป็น % ของแบตเตอรี่)
      battery: 86.6,
      // ไม่ระบุ timezone — ต้องถูกตีความเป็น UTC ไม่ใช่เวลาท้องถิ่นของ server
      sendTime: '2026-08-01 10:00:00',
    });

    await waitFor(async () => (await prisma.logDays.count({ where: { serial } })) > 0, {
      retries: 60,
      intervalMs: 250,
    });

    const log = await prisma.logDays.findFirst({ where: { serial } });
    expect(log).not.toBeNull();
    expect(log?.temp).toBe(4.2);
    expect(log?.door1).toBe(true);
    expect(log?.battery).toBe(87);
    expect(log?.sendTime.toISOString()).toBe('2026-08-01T10:00:00.000Z');
    // ingest ประทับ deviceId/probeId ให้เอง — ยืนยันว่าเดินผ่าน business logic เดียวกับ MQTT/HTTP
    expect(log?.deviceId).not.toBeNull();
    expect(log?.probeId).not.toBeNull();
  });

  it('device-notification จาก legacy ถูกบันทึกพร้อม probe ที่ derive จาก message', async () => {
    client.emit('device-notification', {
      id: 'legacy-uuid',
      status: false,
      createAt: '2026-08-01T00:00:00.000Z',
      serial,
      message: 'PROBE1/DOOR1/ON',
      detail: 'PROBE1: The door has been open for more than 15 minutes.',
    });

    await waitFor(async () => (await prisma.notifications.count({ where: { serial } })) > 0, {
      retries: 60,
      intervalMs: 250,
    });

    const notification = await prisma.notifications.findFirst({ where: { serial } });
    expect(notification).not.toBeNull();
    expect(notification?.message).toBe('PROBE1/DOOR1/ON');
    expect(notification?.detail).toBe('PROBE1: The door has been open for more than 15 minutes.');
    expect(notification?.probe).toBe('1');
    expect(notification?.probeId).not.toBeNull();
  });

  it('payload ที่ validate ไม่ผ่านถูก nack ทิ้ง ไม่ค้าง unacked แล้ว requeue วน', async () => {
    const before = await prisma.logDays.count({ where: { serial } });

    client.emit('device-log', { serial, temp: 4, sendTime: 'not-a-date' });
    client.emit('device-notification', { serial });

    await waitFor(queueIsDrained, { retries: 60, intervalMs: 250 });

    expect(await queueIsDrained()).toBe(true);
    expect(await prisma.logDays.count({ where: { serial } })).toBe(before);
    expect(await prisma.notifications.count({ where: { serial } })).toBe(1);
  });
});
