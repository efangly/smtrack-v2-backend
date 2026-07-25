import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { API_PREFIX, createTestApp, unwrap } from './utils/create-test-app';
import { E2E_PREFIX, buildDevices, cleanupByPrefix, serialFor } from './fixtures/seed-data';

describe('Devices (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);
    // ล้างตั้งแต่ต้น เผื่อรอบก่อนหน้า crash แล้วทิ้งขยะไว้
    await cleanupByPrefix(prisma, E2E_PREFIX);
  });

  afterAll(async () => {
    await cleanupByPrefix(prisma, E2E_PREFIX);
    await app?.close();
  });

  describe('POST /devices', () => {
    it('สร้าง device ใหม่ได้และบันทึกลง DB จริง', async () => {
      const dto = buildDevices(E2E_PREFIX)[0];

      const res = await request(app.getHttpServer()).post(`${API_PREFIX}/devices`).send(dto);

      expect(res.status).toBe(201);
      const device = unwrap(res.body);
      expect(device.serial).toBe(dto.serial);
      expect(device.id).toEqual(expect.any(String));
      expect(device.online).toBe(false);

      // ยืนยันว่าเข้า DB จริง ไม่ใช่แค่ echo กลับมา
      const inDb = await prisma.devices.findUnique({ where: { serial: dto.serial } });
      expect(inDb).not.toBeNull();
      expect(inDb!.ward).toBe(dto.ward);
    });

    it('ปฏิเสธ payload ที่ขาด field บังคับ (ValidationPipe ทำงาน)', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/devices`)
        .send({ serial: serialFor(E2E_PREFIX, 90) });

      expect(res.status).toBe(400);
      // error ไม่ผ่าน ResponseInterceptor แต่ถูกห่อโดย HttpExceptionFilter เป็น
      // { message, success: false, data: null } — ไม่มี statusCode/path ใน body
      expect(res.body.success).toBe(false);
      expect(res.body.data).toBeNull();

      // HttpExceptionFilter ดึง `message` ออกจาก exception.getResponse() มาใส่ body.message ตรง ๆ
      // ของ ValidationPipe จึงเป็น array ของข้อความ error รายฟิลด์
      const details: string[] = res.body.message;
      expect(details.join(' ')).toMatch(/ward/);
      expect(details.join(' ')).toMatch(/staticName/);
      expect(details.join(' ')).toMatch(/firmware/);
    });

    it('ปฏิเสธ field ที่ผิด type', async () => {
      const dto = {
        ...buildDevices(E2E_PREFIX)[0],
        serial: serialFor(E2E_PREFIX, 91),
        seq: 'ไม่ใช่ตัวเลข',
      };

      const res = await request(app.getHttpServer()).post(`${API_PREFIX}/devices`).send(dto);

      expect(res.status).toBe(400);
    });

    it('ตัด field แปลกปลอมทิ้งตาม whitelist ไม่เขียนลง DB', async () => {
      const dto = { ...buildDevices(E2E_PREFIX)[1], hackerField: 'should-be-stripped' };

      const res = await request(app.getHttpServer()).post(`${API_PREFIX}/devices`).send(dto);

      expect(res.status).toBe(201);
      expect(unwrap(res.body)).not.toHaveProperty('hackerField');
    });
  });

  describe('GET /devices', () => {
    it('คืนรายการที่มี device ที่เพิ่งสร้าง (ไม่เช็ค count รวม เพราะ DB ใช้ร่วมกัน)', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/devices`);

      expect(res.status).toBe(200);
      const devices = unwrap(res.body);
      expect(Array.isArray(devices)).toBe(true);

      const ours = devices.filter((d: { serial: string }) => d.serial.startsWith(E2E_PREFIX));
      expect(ours.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('GET /devices/:serial', () => {
    it('คืน device ที่ตรงกับ serial', async () => {
      const serial = serialFor(E2E_PREFIX, 1);

      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/devices/${serial}`);

      expect(res.status).toBe(200);
      expect(unwrap(res.body).serial).toBe(serial);
    });

    it('คืน 404 เมื่อไม่มี serial นั้น', async () => {
      const res = await request(app.getHttpServer()).get(
        `${API_PREFIX}/devices/${E2E_PREFIX}ไม่มีจริง`,
      );

      expect(res.status).toBe(404);
    });
  });
});
