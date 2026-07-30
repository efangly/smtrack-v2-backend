import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { API_PREFIX, createTestApp, unwrap, waitFor } from './utils/create-test-app';
import { bearerUser } from './utils/auth';
import { buildDevices, cleanupByPrefix, seedDevice } from './fixtures/seed-data';

const PREFIX = 'E2E-REPAIR-';

describe('Device repair (e2e)', () => {
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

  describe('POST /repairs', () => {
    it('ปฏิเสธเมื่อไม่แนบ bearer token', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/repairs`)
        .send({ serial, devName: 'Fridge 1' });

      expect(res.status).toBe(401);
    });

    it('ปฏิเสธ role ที่ไม่มีสิทธิ์ (USER ไม่ใช่ SUPER/SERVICE/ADMIN)', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/repairs`)
        .set('Authorization', bearerUser({ role: 'USER' }))
        .send({ serial, devName: 'Fridge 1' });

      expect(res.status).toBe(403);
    });

    it('สร้างรายการซ่อมได้และบันทึกลง DB จริง', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/repairs`)
        .set('Authorization', bearerUser())
        .send({ serial, devName: 'Fridge 1', detail: 'จอไม่ติด' });

      expect(res.status).toBe(201);
      const repair = unwrap(res.body);
      expect(repair.serial).toBe(serial);

      const inDb = await prisma.repairs.findUnique({ where: { id: repair.id } });
      expect(inDb).not.toBeNull();
    });
  });

  describe('GET /repairs/by-serial/:serial และ /repairs/:id', () => {
    let repairId: string;

    beforeAll(async () => {
      const created = await prisma.repairs.create({ data: { serial, devName: 'Fridge 1' } });
      repairId = created.id;
    });

    it('GET ไม่แนบ bearer token ถูกปฏิเสธ (guard ทุก route รวม GET)', async () => {
      const res = await request(app.getHttpServer()).get(
        `${API_PREFIX}/repairs/by-serial/${serial}`,
      );

      expect(res.status).toBe(401);
    });

    it('GET /repairs/by-serial/:serial คืนประวัติซ่อมของกล่องนั้น', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/repairs/by-serial/${serial}`)
        .set('Authorization', bearerUser());

      expect(res.status).toBe(200);
      const repairs = unwrap(res.body);
      expect(repairs.map((r: { id: string }) => r.id)).toContain(repairId);
    });

    it('GET /repairs/:id คืนรายการซ่อมเดียว', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/repairs/${repairId}`)
        .set('Authorization', bearerUser());

      expect(res.status).toBe(200);
      expect(unwrap(res.body).id).toBe(repairId);
    });
  });

  describe('PUT /repairs/:id', () => {
    it('แก้สถานะซ่อมได้ และตัด serial ที่ส่งมาแปลกปลอมทิ้ง แล้วบันทึก user audit', async () => {
      const created = await prisma.repairs.create({ data: { serial, devName: 'Fridge 1' } });

      const res = await request(app.getHttpServer())
        .put(`${API_PREFIX}/repairs/${created.id}`)
        .set('Authorization', bearerUser())
        .send({ status: 'closed', serial: 'SHOULD-NOT-CHANGE' });

      expect(res.status).toBe(200);
      const updated = unwrap(res.body);
      expect(updated.status).toBe('closed');
      expect(updated.serial).toBe(serial);

      let audits: Awaited<ReturnType<typeof prisma.userAudit.findMany>> = [];
      await waitFor(async () => {
        audits = await prisma.userAudit.findMany({
          where: { entityType: 'repair', entityId: created.id },
        });
        return audits.length > 0;
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('updated');
      expect(audits[0].actorId).toBe('e2e-user');
    });
  });
});
