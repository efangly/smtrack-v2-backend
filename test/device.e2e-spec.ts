import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/create-test-app';
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

      const res = await request(app.getHttpServer()).post('/devices').send(dto);

      expect(res.status).toBe(201);
      expect(res.body.serial).toBe(dto.serial);
      expect(res.body.id).toEqual(expect.any(String));
      expect(res.body.online).toBe(false);

      // ยืนยันว่าเข้า DB จริง ไม่ใช่แค่ echo กลับมา
      const inDb = await prisma.devices.findUnique({ where: { serial: dto.serial } });
      expect(inDb).not.toBeNull();
      expect(inDb!.ward).toBe(dto.ward);
    });

    it('ปฏิเสธ payload ที่ขาด field บังคับ (ValidationPipe ทำงาน)', async () => {
      const res = await request(app.getHttpServer())
        .post('/devices')
        .send({ serial: serialFor(E2E_PREFIX, 90) });

      expect(res.status).toBe(400);
      expect(res.body.statusCode).toBe(400);
      expect(res.body.path).toBe('/devices');

      // หมายเหตุ: HttpExceptionFilter ยัด exception.getResponse() ทั้งก้อนลง field `message`
      // ทำให้ error ของ ValidationPipe ซ้อนสองชั้นเป็น body.message.message[]
      // (รูปแบบนี้ใช้งานได้แต่ client ต้องเจาะสองชั้น — ดูหมายเหตุท้ายรายงาน)
      const details: string[] = res.body.message.message;
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

      const res = await request(app.getHttpServer()).post('/devices').send(dto);

      expect(res.status).toBe(400);
    });

    it('ตัด field แปลกปลอมทิ้งตาม whitelist ไม่เขียนลง DB', async () => {
      const dto = { ...buildDevices(E2E_PREFIX)[1], hackerField: 'should-be-stripped' };

      const res = await request(app.getHttpServer()).post('/devices').send(dto);

      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty('hackerField');
    });
  });

  describe('GET /devices', () => {
    it('คืนรายการที่มี device ที่เพิ่งสร้าง (ไม่เช็ค count รวม เพราะ DB ใช้ร่วมกัน)', async () => {
      const res = await request(app.getHttpServer()).get('/devices');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const ours = res.body.filter((d: { serial: string }) => d.serial.startsWith(E2E_PREFIX));
      expect(ours.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('GET /devices/:serial', () => {
    it('คืน device ที่ตรงกับ serial', async () => {
      const serial = serialFor(E2E_PREFIX, 1);

      const res = await request(app.getHttpServer()).get(`/devices/${serial}`);

      expect(res.status).toBe(200);
      expect(res.body.serial).toBe(serial);
    });

    it('คืน 404 เมื่อไม่มี serial นั้น', async () => {
      const res = await request(app.getHttpServer()).get(`/devices/${E2E_PREFIX}ไม่มีจริง`);

      expect(res.status).toBe(404);
    });
  });
});
