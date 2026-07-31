import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { API_PREFIX, createTestApp, unwrap } from './utils/create-test-app';
import { bearerUser } from './utils/auth';

const PREFIX = 'E2E-FIRMWARE-';

describe('Firmware (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const cleanup = () => prisma.firmwares.deleteMany({ where: { version: { startsWith: PREFIX } } });

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  describe('POST /firmware', () => {
    it('ปฏิเสธเมื่อไม่แนบ bearer token', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/firmware`)
        .field('version', `${PREFIX}1.0.0`)
        .field('name', 'v1')
        .attach('file', Buffer.from('binary-content'), 'app.bin');

      expect(res.status).toBe(401);
    });

    it('ปฏิเสธ role ที่ไม่มีสิทธิ์ (USER ไม่ใช่ SUPER/SERVICE/ADMIN)', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/firmware`)
        .set('Authorization', bearerUser({ role: 'USER' }))
        .field('version', `${PREFIX}1.0.0`)
        .field('name', 'v1')
        .attach('file', Buffer.from('binary-content'), 'app.bin');

      expect(res.status).toBe(403);
    });

    it('อัปโหลด firmware ได้และบันทึกลง DB จริง', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/firmware`)
        .set('Authorization', bearerUser())
        .field('version', `${PREFIX}1.0.0`)
        .field('name', 'v1')
        .field('description', 'first release')
        .attach('file', Buffer.from('binary-content'), 'app.bin');

      expect(res.status).toBe(201);
      const firmware = unwrap(res.body);
      expect(firmware.version).toBe(`${PREFIX}1.0.0`);
      expect(firmware.fileName).toBe('app.bin');

      const inDb = await prisma.firmwares.findUnique({ where: { id: firmware.id } });
      expect(inDb).not.toBeNull();
    });

    it('ปฏิเสธเมื่อ version ซ้ำ (unique constraint → 409)', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/firmware`)
        .set('Authorization', bearerUser())
        .field('version', `${PREFIX}1.0.0`)
        .field('name', 'v1 duplicate')
        .attach('file', Buffer.from('binary-content'), 'app.bin');

      expect(res.status).toBe(409);
    });
  });

  describe('GET /firmware, /firmware/:id', () => {
    it('GET /firmware ไม่แนบ bearer token ถูกปฏิเสธ', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/firmware`);
      expect(res.status).toBe(401);
    });

    it('GET /firmware คืนรายการแบบ paginate', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/firmware`)
        .set('Authorization', bearerUser());

      expect(res.status).toBe(200);
      expect(res.body.meta).toBeDefined();
    });

    it('GET /firmware/:id คืนรายการเดียว', async () => {
      const created = await prisma.firmwares.create({
        data: {
          version: `${PREFIX}2.0.0`,
          name: 'v2',
          fileKey: 'firmware/e2e-fake-key.bin',
          fileName: 'app.bin',
          fileSize: 4,
        },
      });

      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/firmware/${created.id}`)
        .set('Authorization', bearerUser());

      expect(res.status).toBe(200);
      expect(unwrap(res.body).id).toBe(created.id);
    });
  });

  describe('GET /firmware/latest และ /firmware/download/:version — public, ไม่ต้องมี token', () => {
    it('GET /firmware/latest คืน firmware ล่าสุดโดยไม่ต้องแนบ token', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/firmware/latest`);

      expect(res.status).toBe(200);
      expect(unwrap(res.body).version).toBeDefined();
    });

    it('GET /firmware/download/:version ดาวน์โหลดไฟล์กลับมาโดยไม่ต้องแนบ token', async () => {
      const res = await request(app.getHttpServer()).get(
        `${API_PREFIX}/firmware/download/${PREFIX}1.0.0`,
      );

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('app.bin');
      // Content-Type: application/octet-stream → supertest เก็บ body เป็น Buffer แทน res.text
      expect(Buffer.from(res.body).toString('utf8')).toBe('binary-content');
    });

    it('GET /firmware/download/:version คืน 404 ถ้าไม่มีเวอร์ชั่นนี้', async () => {
      const res = await request(app.getHttpServer()).get(
        `${API_PREFIX}/firmware/download/${PREFIX}does-not-exist`,
      );

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /firmware/:id', () => {
    it('แก้ไข metadata ได้ และตัด version ที่ส่งมาแปลกปลอมทิ้ง', async () => {
      const created = await prisma.firmwares.create({
        data: {
          version: `${PREFIX}3.0.0`,
          name: 'v3',
          fileKey: 'firmware/e2e-fake-key-2.bin',
          fileName: 'app.bin',
          fileSize: 4,
        },
      });

      const res = await request(app.getHttpServer())
        .put(`${API_PREFIX}/firmware/${created.id}`)
        .set('Authorization', bearerUser())
        .field('name', 'v3-renamed')
        .field('version', 'SHOULD-NOT-CHANGE');

      expect(res.status).toBe(200);
      const updated = unwrap(res.body);
      expect(updated.name).toBe('v3-renamed');
      expect(updated.version).toBe(`${PREFIX}3.0.0`);
    });
  });

  describe('DELETE /firmware/:id', () => {
    it('ลบ record ออกจาก DB จริง', async () => {
      const created = await prisma.firmwares.create({
        data: {
          version: `${PREFIX}4.0.0`,
          name: 'v4',
          fileKey: 'firmware/e2e-fake-key-3.bin',
          fileName: 'app.bin',
          fileSize: 4,
        },
      });

      const res = await request(app.getHttpServer())
        .delete(`${API_PREFIX}/firmware/${created.id}`)
        .set('Authorization', bearerUser());

      expect(res.status).toBe(200);

      const inDb = await prisma.firmwares.findUnique({ where: { id: created.id } });
      expect(inDb).toBeNull();
    });
  });
});
