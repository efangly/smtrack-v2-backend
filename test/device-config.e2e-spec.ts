import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { API_PREFIX, createTestApp, unwrap, waitFor } from './utils/create-test-app';
import { bearerUser } from './utils/auth';
import { buildDevices, cleanupByPrefix, seedDevice } from './fixtures/seed-data';

const PREFIX = 'E2E-CFG-';

describe('Device config (e2e)', () => {
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

  describe('POST /devices/:deviceId/config', () => {
    it('ปฏิเสธเมื่อไม่แนบ bearer token', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/devices/${deviceId}/config`)
        .send({ ssid: 'RDE3' });

      expect(res.status).toBe(401);
    });

    it('ปฏิเสธ role ที่ไม่มีสิทธิ์ (USER ไม่ใช่ SUPER/SERVICE/ADMIN)', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/devices/${deviceId}/config`)
        .set('Authorization', bearerUser({ role: 'USER' }))
        .send({ ssid: 'RDE3' });

      expect(res.status).toBe(403);
    });

    it('สร้าง config ผูกกับ device ได้และบันทึกลง DB จริง', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/devices/${deviceId}/config`)
        .set('Authorization', bearerUser())
        .send({ ssid: 'RDE3_2.4GHz', dhcp: true });

      expect(res.status).toBe(201);
      const config = unwrap(res.body);
      expect(config.deviceId).toBe(deviceId);
      expect(config.ssid).toBe('RDE3_2.4GHz');

      const inDb = await prisma.configs.findUnique({ where: { deviceId } });
      expect(inDb).not.toBeNull();
    });

    it('สร้างซ้ำ deviceId เดิม (unique) ต้องล้มเหลวด้วย 409', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/devices/${deviceId}/config`)
        .set('Authorization', bearerUser())
        .send({ ssid: 'AnotherSsid' });

      expect(res.status).toBe(409);
    });
  });

  describe('GET /devices/:deviceId/config', () => {
    it('ไม่ต้อง auth และคืน config ของ device', async () => {
      const res = await request(app.getHttpServer()).get(
        `${API_PREFIX}/devices/${deviceId}/config`,
      );

      expect(res.status).toBe(200);
      expect(unwrap(res.body).deviceId).toBe(deviceId);
    });

    it('คืน 404 เมื่อ device นั้นยังไม่มี config', async () => {
      const other = await seedDevice(prisma, buildDevices(PREFIX)[1]);

      const res = await request(app.getHttpServer()).get(
        `${API_PREFIX}/devices/${other.deviceId}/config`,
      );

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /devices/:deviceId/config', () => {
    it('ปฏิเสธ role ที่ไม่มีสิทธิ์ (USER ไม่ใช่ SUPER/SERVICE/ADMIN)', async () => {
      const res = await request(app.getHttpServer())
        .put(`${API_PREFIX}/devices/${deviceId}/config`)
        .set('Authorization', bearerUser({ role: 'USER' }))
        .send({ ssid: 'ForbiddenSsid' });

      expect(res.status).toBe(403);
    });

    it('แก้ config ได้และบันทึก user audit ของผู้แก้', async () => {
      const res = await request(app.getHttpServer())
        .put(`${API_PREFIX}/devices/${deviceId}/config`)
        .set('Authorization', bearerUser())
        .send({ ssid: 'UpdatedSsid' });

      expect(res.status).toBe(200);
      expect(unwrap(res.body).ssid).toBe('UpdatedSsid');

      const config = await prisma.configs.findUnique({ where: { deviceId } });
      let audits: Awaited<ReturnType<typeof prisma.userAudit.findMany>> = [];
      await waitFor(async () => {
        audits = await prisma.userAudit.findMany({
          where: { entityType: 'config', entityId: config!.id },
        });
        return audits.some((a) => a.action === 'updated');
      });
      expect(audits.some((a) => a.action === 'updated')).toBe(true);
      expect(audits[0].actorId).toBe('e2e-user');
    });
  });

  describe('DELETE /devices/:deviceId/config', () => {
    it('ปฏิเสธ role ที่ไม่มีสิทธิ์ (USER ไม่ใช่ SUPER/SERVICE/ADMIN)', async () => {
      const res = await request(app.getHttpServer())
        .delete(`${API_PREFIX}/devices/${deviceId}/config`)
        .set('Authorization', bearerUser({ role: 'USER' }));

      expect(res.status).toBe(403);
    });

    it('ลบ config ได้', async () => {
      const res = await request(app.getHttpServer())
        .delete(`${API_PREFIX}/devices/${deviceId}/config`)
        .set('Authorization', bearerUser());

      expect(res.status).toBe(200);

      const inDb = await prisma.configs.findUnique({ where: { deviceId } });
      expect(inDb).toBeNull();
    });
  });
});
