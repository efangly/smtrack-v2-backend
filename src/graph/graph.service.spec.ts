import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { GraphService, UNASSIGNED_CHANNEL } from './graph.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GraphRange } from './dto/query-graph.dto';

/** probe แบบย่อ — ทดสอบสนใจแค่ field ที่ถูกยกไปใส่ series */
const probe = (id: string, channel: string, name: string | null = `P${channel}`) => ({
  id,
  channel,
  name,
  tempMin: 2,
  tempMax: 8,
  humiMin: 10,
  humiMax: 90,
});

const log = (id: string, probeId: string | null, temp = 5) => ({ id, probeId, temp });

describe('GraphService', () => {
  let service: GraphService;
  let prisma: { logDays: { findMany: jest.Mock }; probes: { findMany: jest.Mock } };
  let redis: { getOrSet: jest.Mock };

  beforeEach(async () => {
    prisma = {
      logDays: { findMany: jest.fn().mockResolvedValue([]) },
      probes: { findMany: jest.fn().mockResolvedValue([]) },
    };
    // cache-aside: เรียก factory ตรงเพื่อทดสอบ query จริงโดยไม่ผ่าน redis จริง
    redis = {
      getOrSet: jest.fn((_key: string, _ttl: number, factory: () => unknown) => factory()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GraphService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get(GraphService);
  });

  const logWhere = () => prisma.logDays.findMany.mock.calls[0][0].where;

  describe('ช่วงเวลา', () => {
    it('default เป็น range=1d เมื่อไม่ระบุ range', async () => {
      await service.series('dev-1', {});
      const { sendTime } = logWhere();
      const diffDays = (sendTime.lte.getTime() - sendTime.gte.getTime()) / (24 * 60 * 60 * 1000);
      expect(diffDays).toBeCloseTo(1, 5);
    });

    it.each([
      [GraphRange.DAY, 1],
      [GraphRange.WEEK, 7],
      [GraphRange.MONTH, 30],
    ])('range=%s คำนวณ from ย้อนหลัง %i วันจากปัจจุบัน', async (range, days) => {
      await service.series('dev-1', { range });
      const where = logWhere();
      expect(where.deviceId).toBe('dev-1');
      const diffDays =
        (where.sendTime.lte.getTime() - where.sendTime.gte.getTime()) / (24 * 60 * 60 * 1000);
      expect(diffDays).toBeCloseTo(days, 5);
    });

    it('range=custom ใช้ from/to ที่ระบุ query ตรง ๆ', async () => {
      await service.series('dev-1', {
        range: GraphRange.CUSTOM,
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-10T00:00:00.000Z',
      });
      const { sendTime } = logWhere();
      expect(sendTime.gte).toEqual(new Date('2026-07-01T00:00:00.000Z'));
      expect(sendTime.lte).toEqual(new Date('2026-07-10T00:00:00.000Z'));
    });

    it('range=custom ไม่มี from หรือ to → BadRequestException', async () => {
      await expect(
        service.series('dev-1', { range: GraphRange.CUSTOM, from: '2026-07-01T00:00:00.000Z' }),
      ).rejects.toThrow(BadRequestException);
      await expect(service.series('dev-1', { range: GraphRange.CUSTOM })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.logDays.findMany).not.toHaveBeenCalled();
    });
  });

  describe('แยก series ต่อ probe', () => {
    it('log ของแต่ละ probe ถูกแยกเป็นเส้นของตัวเอง พร้อม threshold ของ probe นั้น', async () => {
      prisma.probes.findMany.mockResolvedValue([probe('p1', '1'), probe('p2', '2')]);
      prisma.logDays.findMany.mockResolvedValue([log('a', 'p1'), log('b', 'p2'), log('c', 'p1')]);

      const series = await service.series('dev-1', { range: GraphRange.DAY });

      expect(series).toHaveLength(2);
      expect(series[0]).toMatchObject({ probeId: 'p1', channel: '1', tempMin: 2, tempMax: 8 });
      expect(series[0].points.map((p) => p.id)).toEqual(['a', 'c']);
      expect(series[1].points.map((p) => p.id)).toEqual(['b']);
    });

    it('probe ที่ไม่มี log ในช่วงนั้นยังคืนมาเป็นเส้นว่าง (สัญญาณว่า probe หลุด/เสีย)', async () => {
      prisma.probes.findMany.mockResolvedValue([probe('p1', '1'), probe('p2', '2')]);
      prisma.logDays.findMany.mockResolvedValue([log('a', 'p1')]);

      const series = await service.series('dev-1', {});

      expect(series.map((s) => s.probeId)).toEqual(['p1', 'p2']);
      expect(series[1].points).toEqual([]);
    });

    it('log ที่ probeId ว่างถูกรวมเป็น series unassigned ไม่ถูกทิ้งเงียบ ๆ', async () => {
      prisma.probes.findMany.mockResolvedValue([probe('p1', '1')]);
      prisma.logDays.findMany.mockResolvedValue([log('a', 'p1'), log('b', null)]);

      const series = await service.series('dev-1', {});

      expect(series).toHaveLength(2);
      const unassigned = series[1];
      expect(unassigned.probeId).toBeNull();
      expect(unassigned.channel).toBe(UNASSIGNED_CHANNEL);
      expect(unassigned.points.map((p) => p.id)).toEqual(['b']);
    });

    it('log ที่ชี้ไป probe ที่ไม่อยู่ในรายการ (ถูกลบไปแล้ว) ตกเข้า unassigned', async () => {
      prisma.probes.findMany.mockResolvedValue([probe('p1', '1')]);
      prisma.logDays.findMany.mockResolvedValue([log('b', 'p-deleted')]);

      const series = await service.series('dev-1', {});

      expect(series[0].points).toEqual([]);
      expect(series[1].points.map((p) => p.id)).toEqual(['b']);
    });

    it('ไม่มี log ที่ไม่ผูก probe → ไม่มี series unassigned โผล่มา', async () => {
      prisma.probes.findMany.mockResolvedValue([probe('p1', '1')]);
      prisma.logDays.findMany.mockResolvedValue([log('a', 'p1')]);

      const series = await service.series('dev-1', {});

      expect(series).toHaveLength(1);
    });

    it('คืนค่าดิบตรงจาก prisma เรียงตาม sendTime asc (ไม่ average/downsample)', async () => {
      prisma.probes.findMany.mockResolvedValue([probe('p1', '1')]);
      const rows = [log('1', 'p1', 5.5), log('2', 'p1', 6.1)];
      prisma.logDays.findMany.mockResolvedValue(rows);

      const series = await service.series('dev-1', { range: GraphRange.DAY });

      expect(prisma.logDays.findMany.mock.calls[0][0].orderBy).toEqual({ sendTime: 'asc' });
      expect(series[0].points).toEqual(rows);
    });
  });

  describe('filter probeId', () => {
    it('ระบุ probeId → query ทั้ง log และ probe เฉพาะตัวนั้น ได้เส้นเดียว', async () => {
      prisma.probes.findMany.mockResolvedValue([probe('p2', '2')]);
      prisma.logDays.findMany.mockResolvedValue([log('b', 'p2')]);

      const series = await service.series('dev-1', { probeId: 'p2' });

      expect(logWhere().probeId).toBe('p2');
      expect(prisma.probes.findMany.mock.calls[0][0].where).toEqual({
        deviceId: 'dev-1',
        id: 'p2',
      });
      expect(series).toHaveLength(1);
      expect(series[0].probeId).toBe('p2');
    });

    it('ระบุ probeId แล้ว log ที่ไม่เข้าเส้นนั้นไม่กลายเป็น unassigned (ผู้ใช้ขอเส้นเดียว)', async () => {
      prisma.probes.findMany.mockResolvedValue([probe('p2', '2')]);
      prisma.logDays.findMany.mockResolvedValue([log('x', null)]);

      const series = await service.series('dev-1', { probeId: 'p2' });

      expect(series).toHaveLength(1);
      expect(series[0].probeId).toBe('p2');
    });

    it('cache key แยกตาม probeId ไม่งั้นเส้นเดียวกับทุกเส้นใช้ cache ปนกัน', async () => {
      await service.series('dev-1', { range: GraphRange.DAY });
      await service.series('dev-1', { range: GraphRange.DAY, probeId: 'p2' });

      const [keyAll] = redis.getOrSet.mock.calls[0];
      const [keyOne] = redis.getOrSet.mock.calls[1];
      expect(keyAll).toMatch(/:all$/);
      expect(keyOne).toMatch(/:p2$/);
    });
  });
});
