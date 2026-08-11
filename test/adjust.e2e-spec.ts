import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { API_PREFIX, createTestApp, unwrap } from './utils/create-test-app';
import {
  buildDevices,
  cleanupByPrefix,
  seedConfig,
  seedDevice,
  seedProbe,
} from './fixtures/seed-data';

const PREFIX = 'E2E-ADJUST-';

describe('Adjust (e2e) — endpoint ไม่มี auth สำหรับอุปกรณ์ IoT', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let deviceId: string;
  let serial: string;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);
    await cleanupByPrefix(prisma, PREFIX);

    const seedDef = buildDevices(PREFIX)[0];
    serial = seedDef.serial;
    const seeded = await seedDevice(prisma, seedDef);
    deviceId = seeded.deviceId;
    await seedProbe(prisma, deviceId, { name: 'P1', channel: '1' });
    await seedConfig(prisma, deviceId, { ssid: 'RDE3_2.4GHz' });
  });

  afterAll(async () => {
    await cleanupByPrefix(prisma, PREFIX);
    await app?.close();
  });

  describe('GET /adjust/:serial', () => {
    it('ไม่ต้อง auth และคืน device + config + probe ของอุปกรณ์นั้น', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/adjust/${serial}`);

      expect(res.status).toBe(200);
      const snapshot = unwrap(res.body);
      expect(snapshot.device.serial).toBe(serial);
      expect(snapshot.config.ssid).toBe('RDE3_2.4GHz');
      expect(snapshot.probe).toHaveLength(1);
      expect(snapshot.probe[0].channel).toBe('1');
    });

    it('คืน 404 เมื่อไม่พบ serial', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/adjust/${PREFIX}missing`);

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /adjust/:serial/probe/:channel', () => {
    it('ไม่ต้อง auth และแก้ threshold/calibration ของ probe channel ที่มีอยู่ได้', async () => {
      const res = await request(app.getHttpServer())
        .put(`${API_PREFIX}/adjust/${serial}/probe/1`)
        .send({ tempAdj: 1.5, tempMax: 9 });

      expect(res.status).toBe(200);
      const probe = unwrap(res.body);
      expect(probe.tempAdj).toBe(1.5);
      expect(probe.tempMax).toBe(9);

      const inDb = await prisma.probes.findUnique({
        where: { deviceId_channel: { deviceId, channel: '1' } },
      });
      expect(inDb?.tempAdj).toBe(1.5);
    });

    it('channel ที่ยังไม่มี → auto-provision probe ใหม่แล้วอัปเดตค่าที่ส่งมา', async () => {
      const res = await request(app.getHttpServer())
        .put(`${API_PREFIX}/adjust/${serial}/probe/2`)
        .send({ tempMin: 1, tempMax: 7 });

      expect(res.status).toBe(200);
      const probe = unwrap(res.body);
      expect(probe.channel).toBe('2');
      expect(probe.tempMax).toBe(7);

      const inDb = await prisma.probes.findUnique({
        where: { deviceId_channel: { deviceId, channel: '2' } },
      });
      expect(inDb).not.toBeNull();
    });
  });

  describe('PATCH /adjust/:serial/config', () => {
    it('ไม่ต้อง auth และแก้ network/email config ได้', async () => {
      const res = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/adjust/${serial}/config`)
        .send({ ssid: 'UpdatedSsid' });

      expect(res.status).toBe(200);
      expect(unwrap(res.body).ssid).toBe('UpdatedSsid');

      const inDb = await prisma.configs.findUnique({ where: { deviceId } });
      expect(inDb?.ssid).toBe('UpdatedSsid');
    });

    it('คืน 404 เมื่อ device นั้นยังไม่มี config แถวอยู่เลย', async () => {
      const other = await seedDevice(prisma, buildDevices(PREFIX)[1]);

      const res = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/adjust/${buildDevices(PREFIX)[1].serial}/config`)
        .send({ ssid: 'NoConfigYet' });

      expect(res.status).toBe(404);
      expect(other.deviceId).toBeTruthy();
    });
  });

  describe('PATCH /adjust/:serial', () => {
    it('ไม่ต้อง auth และแก้ name/remark/position ได้', async () => {
      const res = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/adjust/${serial}`)
        .send({ name: 'Updated Name', remark: 'calibrated by device', position: 'shelf-2' });

      expect(res.status).toBe(200);
      const device = unwrap(res.body);
      expect(device.name).toBe('Updated Name');
      expect(device.remark).toBe('calibrated by device');
      expect(device.position).toBe('shelf-2');

      const inDb = await prisma.devices.findUnique({ where: { id: deviceId } });
      expect(inDb?.name).toBe('Updated Name');
    });

    it('ฟิลด์ที่ไม่ได้อยู่ใน DTO (เช่น staticName/ward) ต้องถูก whitelist strip ทิ้ง ไม่กระทบข้อมูลจริง', async () => {
      const before = await prisma.devices.findUnique({ where: { id: deviceId } });

      const res = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/adjust/${serial}`)
        .send({ remark: 'second update', staticName: 'HIJACKED', ward: 'HIJACKED-WARD' });

      expect(res.status).toBe(200);

      const inDb = await prisma.devices.findUnique({ where: { id: deviceId } });
      expect(inDb?.remark).toBe('second update');
      expect(inDb?.staticName).toBe(before?.staticName);
      expect(inDb?.ward).toBe(before?.ward);
    });
  });
});
