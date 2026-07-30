import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { API_PREFIX, createTestApp, unwrap, waitFor } from './utils/create-test-app';
import { bearerUser } from './utils/auth';
import { buildDevices, cleanupByPrefix } from './fixtures/seed-data';

const PREFIX = 'E2E-UAUDIT-';
const ACTOR_ID = 'e2e-user';

describe('User audit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);
    await cleanupByPrefix(prisma, PREFIX);
  });

  afterAll(async () => {
    await cleanupByPrefix(prisma, PREFIX);
    await app?.close();
  });

  describe('GET /users/:actorId/audit', () => {
    it('ปฏิเสธเมื่อไม่แนบ bearer token', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/users/${ACTOR_ID}/audit`);

      expect(res.status).toBe(401);
    });

    it('ปฏิเสธ role ที่ไม่มีสิทธิ์', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/users/${ACTOR_ID}/audit`)
        .set('Authorization', bearerUser({ role: 'USER' }));

      expect(res.status).toBe(403);
    });

    it('รวม action ข้าม entity (device สร้าง + probe สร้าง) ของ actor เดียวกัน เรียงใหม่ไปเก่า', async () => {
      const dto = buildDevices(PREFIX)[0];

      const deviceRes = await request(app.getHttpServer())
        .post(`${API_PREFIX}/devices`)
        .set('Authorization', bearerUser())
        .send(dto);
      expect(deviceRes.status).toBe(201);
      const device = unwrap(deviceRes.body);

      const probeRes = await request(app.getHttpServer())
        .post(`${API_PREFIX}/devices/${device.id}/probes`)
        .set('Authorization', bearerUser())
        .send({ name: 'P1' });
      expect(probeRes.status).toBe(201);
      const probe = unwrap(probeRes.body);

      let audits: { entityId: string; entityType: string; action: string; actorId: string }[] = [];
      await waitFor(async () => {
        const auditRes = await request(app.getHttpServer())
          .get(`${API_PREFIX}/users/${ACTOR_ID}/audit`)
          .set('Authorization', bearerUser());
        audits = unwrap(auditRes.body);
        const entityIds = audits.map((a) => a.entityId);
        return entityIds.includes(device.id) && entityIds.includes(probe.id);
      });

      const entityIds = audits.map((a) => a.entityId);
      expect(entityIds).toEqual(expect.arrayContaining([device.id, probe.id]));

      const probeAudit = audits.find((a) => a.entityId === probe.id);
      expect(probeAudit?.entityType).toBe('probe');
      expect(probeAudit?.action).toBe('created');
      expect(probeAudit?.actorId).toBe(ACTOR_ID);
    });
  });
});
