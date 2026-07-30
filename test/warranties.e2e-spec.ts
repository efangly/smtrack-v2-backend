import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { API_PREFIX, createTestApp, unwrap, waitFor } from './utils/create-test-app';
import { bearerUser } from './utils/auth';
import { buildDevices, cleanupByPrefix, seedDevice } from './fixtures/seed-data';

const PREFIX = 'E2E-WARRANTY-';

describe('Warranties (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let serial: string;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);
    await cleanupByPrefix(prisma, PREFIX);

    const seed = buildDevices(PREFIX)[0];
    await seedDevice(prisma, seed);
    serial = seed.serial;
  });

  afterAll(async () => {
    await cleanupByPrefix(prisma, PREFIX);
    await app?.close();
  });

  describe('POST /warranties', () => {
    it('ปฏิเสธเมื่อไม่แนบ bearer token', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/warranties`)
        .send({ serial, devName: 'Fridge 1' });

      expect(res.status).toBe(401);
    });

    it('ปฏิเสธ role ที่ไม่มีสิทธิ์ (USER ไม่ใช่ SUPER/SERVICE/ADMIN)', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/warranties`)
        .set('Authorization', bearerUser({ role: 'USER' }))
        .send({ serial, devName: 'Fridge 1' });

      expect(res.status).toBe(403);
    });

    it('สร้างรายการประกันได้และบันทึกลง DB จริง', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/warranties`)
        .set('Authorization', bearerUser())
        .send({ serial, devName: 'Fridge 1', customerName: 'โรงพยาบาล A' });

      expect(res.status).toBe(201);
      const warranty = unwrap(res.body);
      expect(warranty.serial).toBe(serial);

      const inDb = await prisma.warranties.findUnique({ where: { id: warranty.id } });
      expect(inDb).not.toBeNull();
    });
  });

  describe('GET /warranties/by-serial/:serial และ /warranties/:id', () => {
    let warrantyId: string;

    beforeAll(async () => {
      const created = await prisma.warranties.create({
        data: { serial, devName: 'Fridge 1', customerName: 'โรงพยาบาล A' },
      });
      warrantyId = created.id;
    });

    it('GET ไม่แนบ bearer token ถูกปฏิเสธ (guard ทุก route รวม GET)', async () => {
      const res = await request(app.getHttpServer()).get(
        `${API_PREFIX}/warranties/by-serial/${serial}`,
      );

      expect(res.status).toBe(401);
    });

    it('GET /warranties/by-serial/:serial คืนประวัติประกันของกล่องนั้น', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/warranties/by-serial/${serial}`)
        .set('Authorization', bearerUser());

      expect(res.status).toBe(200);
      const warranties = unwrap(res.body);
      expect(warranties.map((w: { id: string }) => w.id)).toContain(warrantyId);
    });

    it('GET /warranties/:id คืนรายการประกันเดียว', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/warranties/${warrantyId}`)
        .set('Authorization', bearerUser());

      expect(res.status).toBe(200);
      expect(unwrap(res.body).id).toBe(warrantyId);
    });
  });

  describe('PUT /warranties/:id', () => {
    it('แก้สถานะประกันได้ และตัด serial ที่ส่งมาแปลกปลอมทิ้ง แล้วบันทึก user audit', async () => {
      const created = await prisma.warranties.create({
        data: { serial, devName: 'Fridge 1', customerName: 'โรงพยาบาล A' },
      });

      const res = await request(app.getHttpServer())
        .put(`${API_PREFIX}/warranties/${created.id}`)
        .set('Authorization', bearerUser())
        .send({ status: false, serial: 'SHOULD-NOT-CHANGE' });

      expect(res.status).toBe(200);
      const updated = unwrap(res.body);
      expect(updated.status).toBe(false);
      expect(updated.serial).toBe(serial);

      let audits: Awaited<ReturnType<typeof prisma.userAudit.findMany>> = [];
      await waitFor(async () => {
        audits = await prisma.userAudit.findMany({
          where: { entityType: 'warranty', entityId: created.id },
        });
        return audits.length > 0;
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('updated');
      expect(audits[0].actorId).toBe('e2e-user');
    });
  });
});
