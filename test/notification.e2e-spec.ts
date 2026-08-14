import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { API_PREFIX, createTestApp, unwrap, TestAppMocks } from './utils/create-test-app';
import { bearerDevice, bearerUser } from './utils/auth';
import {
  E2E_PREFIX,
  buildDevices,
  buildNotifications,
  cleanupByPrefix,
  seedDevice,
  serialFor,
} from './fixtures/seed-data';

describe('Notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mocks: TestAppMocks;

  const serial = serialFor(E2E_PREFIX, 1);
  let deviceId: string;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);
    mocks = ctx.mocks;

    await cleanupByPrefix(prisma, E2E_PREFIX);
    ({ deviceId } = await seedDevice(prisma, buildDevices(E2E_PREFIX)[0]));
  });

  afterAll(async () => {
    await cleanupByPrefix(prisma, E2E_PREFIX);
    await app?.close();
  });

  beforeEach(() => {
    mocks.mqtt.publishNotification.mockClear();
    mocks.rabbitmq.emit.mockClear();
  });

  describe('POST /notifications — fan-out ผ่าน MQTT + SSE + FCM (publish ผ่าน RabbitMQ)', () => {
    it('สร้าง notification แล้วบันทึกผล delivery ทั้งสองช่องทางกลับลง DB', async () => {
      const dto = buildNotifications(serial)[0];

      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/notifications`)
        .set('Authorization', bearerDevice(serial))
        .send(dto);

      expect(res.status).toBe(201);
      const created = unwrap(res.body);
      expect(created.serial).toBe(serial);
      expect(created.message).toBe(dto.message);
      // พิสูจน์ว่า fan-out ทำงานและ service เขียนผลจริงกลับ DB (ไม่ได้ปล่อยเป็น false ค้างไว้)
      expect(created.deliveredSse).toBe(true);
      expect(created.deliveredFcm).toBe(true);

      const inDb = await prisma.notifications.findUnique({ where: { id: created.id } });
      expect(inDb!.deliveredSse).toBe(true);
      expect(inDb!.deliveredFcm).toBe(true);
    });

    it('publish ผ่าน MQTT topic ของ deviceId (จุดติดตั้ง) ไม่ใช่ serial ของกล่อง', async () => {
      const dto = buildNotifications(serial)[1];

      await request(app.getHttpServer())
        .post(`${API_PREFIX}/notifications`)
        .set('Authorization', bearerDevice(serial))
        .send(dto);

      expect(mocks.mqtt.publishNotification).toHaveBeenCalledTimes(1);
      expect(mocks.mqtt.publishNotification).toHaveBeenCalledWith(
        deviceId,
        expect.objectContaining({ serial, message: dto.message }),
      );
    });

    it('publish เข้า RabbitMQ (fcm-push) ครั้งเดียว ให้ FCM service แยกต่างหากไปยิง push เอง', async () => {
      const dto = buildNotifications(serial)[2];

      await request(app.getHttpServer())
        .post(`${API_PREFIX}/notifications`)
        .set('Authorization', bearerDevice(serial))
        .send(dto);

      expect(mocks.rabbitmq.emit).toHaveBeenCalledTimes(1);
      expect(mocks.rabbitmq.emit).toHaveBeenCalledWith(
        'fcm-push',
        expect.objectContaining({
          serial,
          notification: { title: dto.message, body: dto.detail },
          data: expect.objectContaining({ serial }),
        }),
      );
    });

    it('publish ไป RabbitMQ ล้มเหลวไม่บล็อก SSE — ยังสร้าง notification สำเร็จแต่ deliveredFcm=false', async () => {
      mocks.rabbitmq.emit.mockRejectedValueOnce(new Error('broker ล่ม'));

      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/notifications`)
        .set('Authorization', bearerDevice(serial))
        .send({ serial, message: 'ทดสอบ FCM ล่ม', detail: 'ต้องไม่ทำให้ request พัง' });

      expect(res.status).toBe(201);
      expect(unwrap(res.body).deliveredSse).toBe(true);
      expect(unwrap(res.body).deliveredFcm).toBe(false);
    });

    it('notification ที่มี probe → payload fcm-push แนบ probe/probeId ไปใน data', async () => {
      await request(app.getHttpServer())
        .post(`${API_PREFIX}/notifications`)
        .set('Authorization', bearerDevice(serial))
        .send({ serial, message: 'PROBE/TEMP/OVER', detail: 'probe 2 อุณหภูมิเกิน', probe: '2' });

      const [, payload] = mocks.rabbitmq.emit.mock.calls[mocks.rabbitmq.emit.mock.calls.length - 1];
      expect(payload.data).toMatchObject({ probe: '2', probeId: expect.any(String) });
    });

    it('notification ที่ไม่มี probe → payload fcm-push ไม่ยัด key probe/probeId ว่างเข้า data', async () => {
      await request(app.getHttpServer())
        .post(`${API_PREFIX}/notifications`)
        .set('Authorization', bearerDevice(serial))
        .send({ serial, message: 'AC/OFF', detail: 'ไฟดับ' });

      const [, payload] = mocks.rabbitmq.emit.mock.calls[mocks.rabbitmq.emit.mock.calls.length - 1];
      expect(payload.data).not.toHaveProperty('probe');
      expect(payload.data).not.toHaveProperty('probeId');
    });

    it('ยิงสองคำขอติดกันด้วย serial ต่างกัน → แต่ละครั้ง publish payload ที่มี serial ถูกต้องของตัวเอง', async () => {
      const serial2 = serialFor(E2E_PREFIX, 2);
      await seedDevice(prisma, buildDevices(E2E_PREFIX)[1]);

      await request(app.getHttpServer())
        .post(`${API_PREFIX}/notifications`)
        .set('Authorization', bearerDevice(serial))
        .send({ serial, message: 'AC/OFF', detail: 'กล่อง 1' });

      await request(app.getHttpServer())
        .post(`${API_PREFIX}/notifications`)
        .set('Authorization', bearerDevice(serial2))
        .send({ serial: serial2, message: 'AC/OFF', detail: 'กล่อง 2' });

      const calls = mocks.rabbitmq.emit.mock.calls.slice(-2);
      expect(calls[0][1]).toMatchObject({ serial });
      expect(calls[1][1]).toMatchObject({ serial: serial2 });
    });

    it('MQTT ล้มเหลวไม่ทำให้ request พัง (notification ยังถูกบันทึก)', async () => {
      mocks.mqtt.publishNotification.mockRejectedValueOnce(new Error('broker ล่ม'));

      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/notifications`)
        .set('Authorization', bearerDevice(serial))
        .send({ serial, message: 'ทดสอบ broker ล่ม', detail: 'ต้องยังบันทึกได้' });

      expect(res.status).toBe(201);
      expect(unwrap(res.body).id).toEqual(expect.any(String));
    });

    it('ปฏิเสธ payload ที่ขาด message', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/notifications`)
        .set('Authorization', bearerDevice(serial))
        .send({ serial });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /notifications/:serial', () => {
    it('คืนรายการของ serial นั้น เรียงจากใหม่ไปเก่า', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/notifications/${serial}`)
        .set('Authorization', bearerUser());

      expect(res.status).toBe(200);
      const items = unwrap(res.body);
      expect(items.length).toBeGreaterThanOrEqual(3);
      expect(items.every((n: { serial: string }) => n.serial === serial)).toBe(true);

      const times = items.map((n: { createAt: string }) => new Date(n.createAt).getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('คืน array ว่างเมื่อ serial ไม่มี notification', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/notifications/${E2E_PREFIX}ไม่มีจริง`)
        .set('Authorization', bearerUser());

      expect(res.status).toBe(200);
      expect(unwrap(res.body)).toEqual([]);
    });
  });
});
