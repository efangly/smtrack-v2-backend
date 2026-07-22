import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, TestAppMocks } from './utils/create-test-app';
import {
  E2E_PREFIX,
  buildDevices,
  buildNotifications,
  cleanupByPrefix,
  serialFor,
} from './fixtures/seed-data';

describe('Notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mocks: TestAppMocks;

  const serial = serialFor(E2E_PREFIX, 1);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);
    mocks = ctx.mocks;

    await cleanupByPrefix(prisma, E2E_PREFIX);
    await prisma.devices.create({ data: buildDevices(E2E_PREFIX)[0] });
  });

  afterAll(async () => {
    await cleanupByPrefix(prisma, E2E_PREFIX);
    await app?.close();
  });

  beforeEach(() => {
    mocks.mqtt.publishNotification.mockClear();
    mocks.fcm.pushToSerial.mockClear();
  });

  describe('POST /notifications — fan-out ผ่าน MQTT + SSE + FCM', () => {
    it('สร้าง notification แล้วบันทึกผล delivery ทั้งสองช่องทางกลับลง DB', async () => {
      const dto = buildNotifications(serial)[0];

      const res = await request(app.getHttpServer()).post('/notifications').send(dto);

      expect(res.status).toBe(201);
      expect(res.body.serial).toBe(serial);
      expect(res.body.message).toBe(dto.message);
      // พิสูจน์ว่า fan-out ทำงานและ service เขียนผลจริงกลับ DB (ไม่ได้ปล่อยเป็น false ค้างไว้)
      expect(res.body.deliveredSse).toBe(true);
      expect(res.body.deliveredFcm).toBe(true);

      const inDb = await prisma.notifications.findUnique({ where: { id: res.body.id } });
      expect(inDb!.deliveredSse).toBe(true);
      expect(inDb!.deliveredFcm).toBe(true);
    });

    it('publish ผ่าน MQTT topic ของ serial นั้น', async () => {
      const dto = buildNotifications(serial)[1];

      await request(app.getHttpServer()).post('/notifications').send(dto);

      expect(mocks.mqtt.publishNotification).toHaveBeenCalledTimes(1);
      expect(mocks.mqtt.publishNotification).toHaveBeenCalledWith(
        serial,
        expect.objectContaining({ serial, message: dto.message }),
      );
    });

    it('broadcast ไป FCM topic ครั้งเดียว ไม่วนส่งราย token', async () => {
      const dto = buildNotifications(serial)[2];

      await request(app.getHttpServer()).post('/notifications').send(dto);

      expect(mocks.fcm.pushToSerial).toHaveBeenCalledTimes(1);
      expect(mocks.fcm.pushToSerial).toHaveBeenCalledWith(
        serial,
        { title: dto.message, body: dto.detail },
        expect.objectContaining({ serial }),
      );
    });

    it('FCM ล้มเหลวไม่บล็อก SSE — ยังสร้าง notification สำเร็จแต่ deliveredFcm=false', async () => {
      mocks.fcm.pushToSerial.mockRejectedValueOnce(new Error('FCM ล่ม'));

      const res = await request(app.getHttpServer())
        .post('/notifications')
        .send({ serial, message: 'ทดสอบ FCM ล่ม', detail: 'ต้องไม่ทำให้ request พัง' });

      expect(res.status).toBe(201);
      expect(res.body.deliveredSse).toBe(true);
      expect(res.body.deliveredFcm).toBe(false);
    });

    it('MQTT ล้มเหลวไม่ทำให้ request พัง (notification ยังถูกบันทึก)', async () => {
      mocks.mqtt.publishNotification.mockRejectedValueOnce(new Error('broker ล่ม'));

      const res = await request(app.getHttpServer())
        .post('/notifications')
        .send({ serial, message: 'ทดสอบ broker ล่ม', detail: 'ต้องยังบันทึกได้' });

      expect(res.status).toBe(201);
      expect(res.body.id).toEqual(expect.any(String));
    });

    it('ปฏิเสธ payload ที่ขาด message', async () => {
      const res = await request(app.getHttpServer()).post('/notifications').send({ serial });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /notifications/:serial', () => {
    it('คืนรายการของ serial นั้น เรียงจากใหม่ไปเก่า', async () => {
      const res = await request(app.getHttpServer()).get(`/notifications/${serial}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(3);
      expect(res.body.every((n: { serial: string }) => n.serial === serial)).toBe(true);

      const times = res.body.map((n: { createAt: string }) => new Date(n.createAt).getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('คืน array ว่างเมื่อ serial ไม่มี notification', async () => {
      const res = await request(app.getHttpServer()).get(`/notifications/${E2E_PREFIX}ไม่มีจริง`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});
