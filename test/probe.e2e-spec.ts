import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { API_PREFIX, createTestApp, unwrap, waitFor } from './utils/create-test-app';
import { bearerUser } from './utils/auth';
import { buildDevices, cleanupByPrefix, seedDevice } from './fixtures/seed-data';

const PREFIX = 'E2E-PROBE-';

describe('Probes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let deviceId: string;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);
    await cleanupByPrefix(prisma, PREFIX);

    const seeded = await seedDevice(prisma, buildDevices(PREFIX)[0]);
    deviceId = seeded.deviceId;
  });

  afterAll(async () => {
    await cleanupByPrefix(prisma, PREFIX);
    await app?.close();
  });

  describe('POST /devices/:deviceId/probes', () => {
    it('ปฏิเสธเมื่อไม่แนบ bearer token', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/devices/${deviceId}/probes`)
        .send({ name: 'P1' });

      expect(res.status).toBe(401);
    });

    it('ปฏิเสธ role ที่ไม่มีสิทธิ์ (USER ไม่ใช่ SUPER/SERVICE/ADMIN)', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/devices/${deviceId}/probes`)
        .set('Authorization', bearerUser({ role: 'USER' }))
        .send({ name: 'P1' });

      expect(res.status).toBe(403);
    });

    it('สร้าง probe ผูกกับ device ได้และบันทึกลง DB จริง', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/devices/${deviceId}/probes`)
        .set('Authorization', bearerUser())
        .send({ name: 'P1', tempMin: 2, tempMax: 8 });

      expect(res.status).toBe(201);
      const probe = unwrap(res.body);
      expect(probe.deviceId).toBe(deviceId);
      expect(probe.tempMax).toBe(8);

      const inDb = await prisma.probes.findUnique({ where: { id: probe.id } });
      expect(inDb).not.toBeNull();
    });

    it('ไม่ส่ง channel → ได้ช่องถัดไปที่ยังว่างของ device นั้น ไม่ชนกับที่มีอยู่', async () => {
      const before = await prisma.probes.findMany({
        where: { deviceId },
        select: { channel: true },
      });

      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/devices/${deviceId}/probes`)
        .set('Authorization', bearerUser())
        .send({ name: 'auto' });

      expect(res.status).toBe(201);
      expect(before.map((p) => p.channel)).not.toContain(unwrap(res.body).channel);
    });

    it('channel ซ้ำใน device เดียวกัน → 409 (business key ของการ resolve probe ตอน ingest)', async () => {
      const existing = await prisma.probes.findFirst({ where: { deviceId } });

      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/devices/${deviceId}/probes`)
        .set('Authorization', bearerUser())
        .send({ name: 'dup', channel: existing!.channel });

      expect(res.status).toBe(409);
    });
  });

  describe('GET /devices/:deviceId/probes และ /probes/:id', () => {
    let probeId: string;

    beforeAll(async () => {
      const created = await prisma.probes.create({ data: { deviceId, name: 'P2', channel: '7' } });
      probeId = created.id;
    });

    it('GET /devices/:deviceId/probes ไม่ต้อง auth และคืน probe ทั้งหมดของ device', async () => {
      const res = await request(app.getHttpServer()).get(
        `${API_PREFIX}/devices/${deviceId}/probes`,
      );

      expect(res.status).toBe(200);
      const probes = unwrap(res.body);
      expect(probes.map((p: { id: string }) => p.id)).toContain(probeId);
    });

    it('GET /probes/:id คืน probe รายตัว', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/probes/${probeId}`);

      expect(res.status).toBe(200);
      expect(unwrap(res.body).id).toBe(probeId);
    });

    it('GET /probes/:id คืน 404 เมื่อไม่พบ', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/probes/missing-id`);

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /probes/:id', () => {
    it('ปฏิเสธ role ที่ไม่มีสิทธิ์ (USER ไม่ใช่ SUPER/SERVICE/ADMIN)', async () => {
      const created = await prisma.probes.create({
        data: { deviceId, name: 'P3-forbidden', channel: '8' },
      });

      const res = await request(app.getHttpServer())
        .put(`${API_PREFIX}/probes/${created.id}`)
        .set('Authorization', bearerUser({ role: 'USER' }))
        .send({ tempMax: 10 });

      expect(res.status).toBe(403);
    });

    it('แก้ probe ได้และบันทึก user audit ของผู้แก้', async () => {
      const created = await prisma.probes.create({ data: { deviceId, name: 'P3', channel: '9' } });

      const res = await request(app.getHttpServer())
        .put(`${API_PREFIX}/probes/${created.id}`)
        .set('Authorization', bearerUser())
        .send({ tempMax: 10 });

      expect(res.status).toBe(200);
      expect(unwrap(res.body).tempMax).toBe(10);

      let audits: Awaited<ReturnType<typeof prisma.userAudit.findMany>> = [];
      await waitFor(async () => {
        audits = await prisma.userAudit.findMany({
          where: { entityType: 'probe', entityId: created.id },
        });
        return audits.length > 0;
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('updated');
      expect(audits[0].actorId).toBe('e2e-user');
    });
  });

  describe('DELETE /probes/:id', () => {
    it('ปฏิเสธ role ที่ไม่มีสิทธิ์ (USER ไม่ใช่ SUPER/SERVICE/ADMIN)', async () => {
      const created = await prisma.probes.create({
        data: { deviceId, name: 'P4-forbidden', channel: '10' },
      });

      const res = await request(app.getHttpServer())
        .delete(`${API_PREFIX}/probes/${created.id}`)
        .set('Authorization', bearerUser({ role: 'USER' }));

      expect(res.status).toBe(403);
    });

    it('ลบ probe ได้และบันทึก user audit action deleted', async () => {
      const created = await prisma.probes.create({ data: { deviceId, name: 'P4', channel: '11' } });

      const res = await request(app.getHttpServer())
        .delete(`${API_PREFIX}/probes/${created.id}`)
        .set('Authorization', bearerUser());

      expect(res.status).toBe(200);

      const inDb = await prisma.probes.findUnique({ where: { id: created.id } });
      expect(inDb).toBeNull();

      let audits: Awaited<ReturnType<typeof prisma.userAudit.findMany>> = [];
      await waitFor(async () => {
        audits = await prisma.userAudit.findMany({
          where: { entityType: 'probe', entityId: created.id, action: 'deleted' },
        });
        return audits.length > 0;
      });
      expect(audits).toHaveLength(1);
    });
  });
});
