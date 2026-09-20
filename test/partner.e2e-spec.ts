import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildGrpcOptions } from '../src/config/grpc.config';
import { API_PREFIX, createTestApp, unwrap, waitFor } from './utils/create-test-app';
import { bearerUser } from './utils/auth';
import { buildDevices, cleanupByPrefix, seedDevice, withDeviceId } from './fixtures/seed-data';

// ต้องตั้งก่อน createTestApp() (configuration.ts อ่าน process.env ตอน ConfigModule init) —
// ใช้ port แยกจาก default (50051) กันชนกับ instance dev ที่รันอยู่จริงบนเครื่องเดียวกัน
const GRPC_TEST_URL = '127.0.0.1:50061';
process.env.GRPC_URL = GRPC_TEST_URL;

const PREFIX = 'E2E-PARTNER-';
const WARD = `${PREFIX}WARD`;

interface PartnerClient extends grpc.Client {
  GetDeviceSnapshot: (
    req: { serial: string },
    metadata: grpc.Metadata,
    callback: (err: grpc.ServiceError | null, res: unknown) => void,
  ) => void;
  GetDeviceHistory: (
    req: { serial: string; range?: string },
    metadata: grpc.Metadata,
    callback: (err: grpc.ServiceError | null, res: unknown) => void,
  ) => void;
  ListDeviceTelemetry: (
    req: { serial: string; range?: string; page?: number; limit?: number },
    metadata: grpc.Metadata,
    callback: (err: grpc.ServiceError | null, res: unknown) => void,
  ) => void;
  ListDevicesByWard: (
    req: { ward: string; page?: number; limit?: number },
    metadata: grpc.Metadata,
    callback: (err: grpc.ServiceError | null, res: unknown) => void,
  ) => void;
}

function buildClient(): PartnerClient {
  const packageDef = protoLoader.loadSync(join(__dirname, '../src/partner/partner.proto'), {
    enums: String,
  });
  const proto = grpc.loadPackageDefinition(packageDef) as unknown as {
    partner: { PartnerService: new (url: string, creds: grpc.ChannelCredentials) => PartnerClient };
  };
  return new proto.partner.PartnerService(GRPC_TEST_URL, grpc.credentials.createInsecure());
}

function call<T>(
  fn: (...args: any[]) => void,
  req: unknown,
  apiKey?: string,
): Promise<{ response?: T; error?: grpc.ServiceError }> {
  const metadata = new grpc.Metadata();
  if (apiKey) metadata.set('x-api-key', apiKey);
  return new Promise((resolve) => {
    fn(req, metadata, (error: grpc.ServiceError | null, response: T) =>
      resolve(error ? { error } : { response }),
    );
  });
}

describe('Partner API (e2e, gRPC)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let client: PartnerClient;
  let serial: string;
  let deviceId: string;
  let keyId: string;
  const rawKey = 'pk_live_e2e-test-key';

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);
    await cleanupByPrefix(prisma, PREFIX);
    await prisma.partnerApiKeys.deleteMany({ where: { name: { startsWith: PREFIX } } });

    const config = ctx.moduleRef.get(ConfigService);
    app.connectMicroservice(buildGrpcOptions(config), { inheritAppConfig: true });
    await app.startAllMicroservices();

    const seed = { ...buildDevices(PREFIX)[0], ward: WARD };
    const { deviceId: id } = await seedDevice(prisma, seed);
    serial = seed.serial;
    deviceId = id;

    const now = Date.now();
    await prisma.logDays.createMany({
      data: withDeviceId(
        [10, 30, 50, 90, 120].map((minutesAgo) => ({
          serial,
          temp: 4.2,
          tempDisplay: 4.2,
          humidity: 55,
          humidityDisplay: 55,
          sendTime: new Date(now - minutesAgo * 60 * 1000),
          plug: true,
          door1: false,
          internet: true,
          probe: '1',
          battery: 90,
        })),
        deviceId,
      ),
    });

    // history: 2 / 5 / 20 / 40 วันก่อน (door1 เปิดเฉพาะแถว 5 วัน) — DAY_1 ต้องเห็นแค่ 5 แถวเดิม, DAY_30 ตัดแถว 40 วันทิ้ง
    const DAY = 24 * 60 * 60 * 1000;
    await prisma.logDays.createMany({
      data: withDeviceId(
        [2, 5, 20, 40].map((daysAgo) => ({
          serial,
          temp: 6,
          tempDisplay: 6,
          humidity: 60,
          humidityDisplay: 60,
          sendTime: new Date(now - daysAgo * DAY),
          plug: true,
          door1: daysAgo === 5,
          internet: true,
          probe: '1',
          battery: 80,
        })),
        deviceId,
      ),
    });

    const key = await prisma.partnerApiKeys.create({
      data: {
        name: `${PREFIX}key`,
        keyHash: createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.slice(0, 16),
        wards: { create: [{ ward: WARD }] },
      },
    });
    keyId = key.id;

    client = buildClient();
  });

  afterAll(async () => {
    client?.close();
    await prisma.partnerApiKeys.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await cleanupByPrefix(prisma, PREFIX);
    await app?.close();
  });

  describe('GetDeviceSnapshot', () => {
    it('ปฏิเสธเมื่อไม่แนบ x-api-key metadata', async () => {
      const { error } = await call<unknown>(client.GetDeviceSnapshot.bind(client), { serial });
      expect(error?.code).toBe(grpc.status.UNAUTHENTICATED);
    });

    it('ปฏิเสธ key ที่ไม่ถูกต้อง', async () => {
      const { error } = await call<unknown>(
        client.GetDeviceSnapshot.bind(client),
        { serial },
        'pk_live_bogus',
      );
      expect(error?.code).toBe(grpc.status.UNAUTHENTICATED);
    });

    it('serial ที่ ward ไม่อยู่ใน allowlist ของ key ตอบ NOT_FOUND', async () => {
      const { error } = await call<unknown>(
        client.GetDeviceSnapshot.bind(client),
        { serial: 'SOME-OTHER-SERIAL-NOT-OWNED' },
        rawKey,
      );
      expect(error?.code).toBe(grpc.status.NOT_FOUND);
    });

    it('คืน metadata + timeseries เฉพาะย้อนหลัง 1 ชั่วโมง (ตัดจุดที่เก่ากว่าออก)', async () => {
      const { response, error } = await call<{
        device: { serial: string; status: boolean; firmware: string; online: boolean };
        timeseries: { sendTime: string }[];
      }>(client.GetDeviceSnapshot.bind(client), { serial }, rawKey);

      expect(error).toBeUndefined();
      expect(response?.device.serial).toBe(serial);
      // seed มี 5 จุด: 10/30/50/90/120 นาทีก่อน — เหลือแค่ 3 จุดแรกที่อยู่ใน 1 ชม.
      expect(response?.timeseries).toHaveLength(3);
    });
  });

  describe('ListDevicesByWard', () => {
    it('ward ที่ไม่อยู่ใน allowlist ตอบ NOT_FOUND', async () => {
      const { error } = await call<unknown>(
        client.ListDevicesByWard.bind(client),
        { ward: 'SOME-OTHER-WARD-NOT-OWNED' },
        rawKey,
      );
      expect(error?.code).toBe(grpc.status.NOT_FOUND);
    });

    it('คืนทุก device ใน ward พร้อม reading ล่าสุดค่าเดียวของแต่ละตัว', async () => {
      const { response, error } = await call<{
        devices: { device: { serial: string }; latest?: { sendTime: string } }[];
        total: number;
      }>(client.ListDevicesByWard.bind(client), { ward: WARD }, rawKey);

      expect(error).toBeUndefined();
      expect(response?.total).toBe(1);
      expect(response?.devices).toHaveLength(1);
      expect(response?.devices[0].device.serial).toBe(serial);
      // ต้องเป็นจุดล่าสุด (10 นาทีก่อน) ไม่ใช่จุดอื่น
      expect(response?.devices[0].latest).toBeDefined();
    });
  });

  describe('GetDeviceHistory', () => {
    type History = {
      device: { serial: string };
      range: string;
      bucketInterval: string;
      buckets: { samples: number; doorOpen?: boolean; batteryMin: number }[];
    };
    const history = (req: { serial: string; range?: string }, key?: string) =>
      call<History>(client.GetDeviceHistory.bind(client), req, key);
    const totalSamples = (h?: History) => (h?.buckets ?? []).reduce((n, b) => n + b.samples, 0);

    it('ปฏิเสธเมื่อไม่แนบ x-api-key', async () => {
      const { error } = await history({ serial, range: 'DAY_7' });
      expect(error?.code).toBe(grpc.status.UNAUTHENTICATED);
    });

    it('ไม่ระบุ range ตอบ INVALID_ARGUMENT', async () => {
      const { error } = await history({ serial }, rawKey);
      expect(error?.code).toBe(grpc.status.INVALID_ARGUMENT);
    });

    it('ward ที่ไม่อยู่ใน allowlist ตอบ NOT_FOUND', async () => {
      const { error } = await history(
        { serial: 'SOME-OTHER-SERIAL-NOT-OWNED', range: 'DAY_7' },
        rawKey,
      );
      expect(error?.code).toBe(grpc.status.NOT_FOUND);
    });

    it('DAY_1: เฉพาะ 5 แถวเดิมที่อยู่ในช่วง 1 วัน, bucket 15 นาที', async () => {
      const { response, error } = await history({ serial, range: 'DAY_1' }, rawKey);
      expect(error).toBeUndefined();
      expect(response?.bucketInterval).toBe('15 minutes');
      expect(response?.range).toBe('DAY_1');
      expect(totalSamples(response)).toBe(5);
    });

    it('DAY_7: รวมแถว 2 และ 5 วันก่อน (รวม 7) และ door_open จากแถว 5 วัน', async () => {
      const { response } = await history({ serial, range: 'DAY_7' }, rawKey);
      expect(response?.bucketInterval).toBe('1 hour');
      expect(totalSamples(response)).toBe(7);
      expect(response?.buckets.some((b) => b.doorOpen)).toBe(true);
    });

    it('DAY_30: รวมแถว 20 วันก่อน (รวม 8) แต่ตัดแถว 40 วันทิ้ง', async () => {
      const { response } = await history({ serial, range: 'DAY_30' }, rawKey);
      expect(response?.bucketInterval).toBe('3 hours');
      expect(totalSamples(response)).toBe(8);
    });
  });

  describe('ListDeviceTelemetry', () => {
    type Table = {
      total: number;
      page: number;
      limit: number;
      range: string;
      points: { sendTime: string }[];
    };
    const list = (
      req: { serial: string; range?: string; page?: number; limit?: number },
      key?: string,
    ) => call<Table>(client.ListDeviceTelemetry.bind(client), req, key);

    it('ปฏิเสธเมื่อไม่แนบ x-api-key', async () => {
      const { error } = await list({ serial, range: 'DAY_7' });
      expect(error?.code).toBe(grpc.status.UNAUTHENTICATED);
    });

    it('ไม่ระบุ range ตอบ INVALID_ARGUMENT', async () => {
      const { error } = await list({ serial }, rawKey);
      expect(error?.code).toBe(grpc.status.INVALID_ARGUMENT);
    });

    it('ward ที่ไม่อยู่ใน allowlist ตอบ NOT_FOUND', async () => {
      const { error } = await list(
        { serial: 'SOME-OTHER-SERIAL-NOT-OWNED', range: 'DAY_7' },
        rawKey,
      );
      expect(error?.code).toBe(grpc.status.NOT_FOUND);
    });

    it('DAY_1 / DAY_7 / DAY_30 นับ total ตามช่วง (5 / 7 / 8)', async () => {
      const totals = await Promise.all(
        ['DAY_1', 'DAY_7', 'DAY_30'].map((range) => list({ serial, range }, rawKey)),
      );
      expect(totals.map((t) => t.response?.total)).toEqual([5, 7, 8]);
    });

    it('แบ่งหน้าเรียงใหม่→เก่า ไม่ซ้ำ ไม่ตกหล่น', async () => {
      const p1 = await list({ serial, range: 'DAY_7', page: 1, limit: 3 }, rawKey);
      const p2 = await list({ serial, range: 'DAY_7', page: 2, limit: 3 }, rawKey);
      const p3 = await list({ serial, range: 'DAY_7', page: 3, limit: 3 }, rawKey);

      expect([p1, p2, p3].map((p) => p.response?.points.length)).toEqual([3, 3, 1]);
      expect(p1.response).toMatchObject({ total: 7, page: 1, limit: 3, range: 'DAY_7' });
      const times = [p1, p2, p3].flatMap((p) => p.response?.points.map((x) => x.sendTime) ?? []);
      expect(new Set(times).size).toBe(7);
      expect([...times].sort().reverse()).toEqual(times);
    });
  });

  describe('audit log', () => {
    it('บันทึกทุก request ลง PartnerApiRequestLogs พร้อม status code จริง', async () => {
      await call<unknown>(client.GetDeviceSnapshot.bind(client), { serial }, rawKey);

      let logs: Awaited<ReturnType<typeof prisma.partnerApiRequestLogs.findMany>> = [];
      await waitFor(async () => {
        logs = await prisma.partnerApiRequestLogs.findMany({
          where: { keyId, serial, path: 'partner.PartnerService/GetDeviceSnapshot' },
        });
        return logs.length > 0;
      });
      expect(logs.some((l) => l.statusCode === grpc.status.OK)).toBe(true);
    });
  });

  describe('/admin/partner-keys (lifecycle ผ่าน HTTP จริง, key ใช้เรียก gRPC ต่อได้)', () => {
    let issuedKeyId: string;
    let issuedApiKey: string;

    it('ปฏิเสธเมื่อไม่แนบ bearer token', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/admin/partner-keys`)
        .send({ name: `${PREFIX}admin-created`, wards: [WARD] });
      expect(res.status).toBe(401);
    });

    it('ปฏิเสธ role ที่ไม่ใช่ SUPER', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/admin/partner-keys`)
        .set('Authorization', bearerUser({ role: 'ADMIN' }))
        .send({ name: `${PREFIX}admin-created`, wards: [WARD] });
      expect(res.status).toBe(403);
    });

    it('SUPER สร้าง key ได้ และเห็น plaintext key แค่ครั้งนี้ครั้งเดียว', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/admin/partner-keys`)
        .set('Authorization', bearerUser())
        .send({ name: `${PREFIX}admin-created`, wards: [WARD] });

      expect(res.status).toBe(201);
      const created = unwrap(res.body);
      expect(created.apiKey).toMatch(/^pk_live_/);
      expect(created.wards).toEqual([WARD]);
      issuedKeyId = created.id;
      issuedApiKey = created.apiKey;

      const inDb = await prisma.partnerApiKeys.findUnique({ where: { id: issuedKeyId } });
      expect(inDb?.keyHash).toBe(createHash('sha256').update(issuedApiKey).digest('hex'));
    });

    it('key ที่สร้างใหม่ผ่าน REST ใช้เรียก gRPC ได้จริง', async () => {
      const { response, error } = await call<{ device: { serial: string } }>(
        client.GetDeviceSnapshot.bind(client),
        { serial },
        issuedApiKey,
      );
      expect(error).toBeUndefined();
      expect(response?.device.serial).toBe(serial);
    });

    it('GET /admin/partner-keys/:id คืนรายละเอียด (ไม่มี key/hash โผล่มา)', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/admin/partner-keys/${issuedKeyId}`)
        .set('Authorization', bearerUser());
      expect(res.status).toBe(200);
      const detail = unwrap(res.body);
      expect(detail.id).toBe(issuedKeyId);
      expect(detail.wards).toEqual([WARD]);
      expect(detail).not.toHaveProperty('keyHash');
      expect(detail).not.toHaveProperty('apiKey');
    });

    it('DELETE /admin/partner-keys/:id revoke แบบ soft แล้ว key ใช้เรียก gRPC ไม่ได้อีก', async () => {
      const res = await request(app.getHttpServer())
        .delete(`${API_PREFIX}/admin/partner-keys/${issuedKeyId}`)
        .set('Authorization', bearerUser());
      expect(res.status).toBe(200);
      expect(unwrap(res.body).revokedAt).not.toBeNull();

      const stillInDb = await prisma.partnerApiKeys.findUnique({ where: { id: issuedKeyId } });
      expect(stillInDb).not.toBeNull();

      const { error } = await call<unknown>(
        client.GetDeviceSnapshot.bind(client),
        { serial },
        issuedApiKey,
      );
      expect(error?.code).toBe(grpc.status.UNAUTHENTICATED);
    });
  });
});
