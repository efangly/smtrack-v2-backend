import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { ProbeResolverService, probeIdCacheKey } from './probe-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { Prisma } from '../generated/prisma/client';
import { AppEvents } from '../common/events/app-events';

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('ProbeResolverService', () => {
  let service: ProbeResolverService;
  let prisma: { probes: { findUnique: jest.Mock; create: jest.Mock } };
  let redis: { getOrSet: jest.Mock };
  let events: { emit: jest.Mock };

  beforeEach(async () => {
    prisma = { probes: { findUnique: jest.fn(), create: jest.fn() } };
    // cache-aside: เรียก factory ตรงเพื่อทดสอบ lookup จริงโดยไม่ผ่าน redis จริง
    redis = {
      getOrSet: jest.fn((_key: string, _ttl: number, factory: () => unknown) => factory()),
    };
    events = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProbeResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();

    service = module.get(ProbeResolverService);
  });

  it('probe ที่มีอยู่แล้ว → คืน id เดิม ไม่สร้างใหม่', async () => {
    prisma.probes.findUnique.mockResolvedValue({ id: 'probe-1' });

    await expect(service.resolveProbeId('dev-1', '2')).resolves.toBe('probe-1');

    expect(prisma.probes.findUnique).toHaveBeenCalledWith({
      where: { deviceId_channel: { deviceId: 'dev-1', channel: '2' } },
      select: { id: true },
    });
    expect(prisma.probes.create).not.toHaveBeenCalled();
  });

  it('cache key แยกตาม device และ channel', async () => {
    prisma.probes.findUnique.mockResolvedValue({ id: 'probe-1' });

    await service.resolveProbeId('dev-1', '2');

    expect(redis.getOrSet).toHaveBeenCalledWith(
      probeIdCacheKey('dev-1', '2'),
      expect.any(Number),
      expect.any(Function),
    );
  });

  it('cache hit ไม่แตะ DB เลย (hot path ตอน ingest)', async () => {
    redis.getOrSet.mockResolvedValue('cached-probe');

    await expect(service.resolveProbeId('dev-1', '1')).resolves.toBe('cached-probe');

    expect(prisma.probes.findUnique).not.toHaveBeenCalled();
  });

  describe('auto-provision', () => {
    it('channel ที่ยังไม่มี probe → สร้างใหม่ด้วยชื่อ P{channel} แล้วคืน id', async () => {
      prisma.probes.findUnique.mockResolvedValue(null);
      prisma.probes.create.mockResolvedValue({ id: 'probe-new', deviceId: 'dev-1', channel: '3' });

      await expect(service.resolveProbeId('dev-1', '3')).resolves.toBe('probe-new');

      expect(prisma.probes.create).toHaveBeenCalledWith({
        data: { deviceId: 'dev-1', channel: '3', name: 'P3' },
      });
    });

    it('emit probe.changed ให้ audit ตามรอย probe ที่โผล่มาเอง โดยไม่มี actor', async () => {
      prisma.probes.findUnique.mockResolvedValue(null);
      prisma.probes.create.mockResolvedValue({ id: 'probe-new', deviceId: 'dev-1', channel: '3' });

      await service.resolveProbeId('dev-1', '3');

      expect(events.emit).toHaveBeenCalledWith(
        AppEvents.PROBE_CHANGED,
        expect.objectContaining({ action: 'created', probeId: 'probe-new', deviceId: 'dev-1' }),
      );
      expect(events.emit.mock.calls[0][1].actor).toBeUndefined();
    });

    it('emit ที่ throw ไม่ทำให้ ingest ล้ม', async () => {
      prisma.probes.findUnique.mockResolvedValue(null);
      prisma.probes.create.mockResolvedValue({ id: 'probe-new', deviceId: 'dev-1', channel: '3' });
      events.emit.mockImplementation(() => {
        throw new Error('listener boom');
      });

      await expect(service.resolveProbeId('dev-1', '3')).resolves.toBe('probe-new');
    });
  });

  describe('race condition', () => {
    it('P2002 (อีก process สร้างชนะไปก่อน) → อ่านซ้ำแล้วใช้ของนั้น ไม่ throw', async () => {
      prisma.probes.findUnique
        .mockResolvedValueOnce(null) // lookup แรก: ยังไม่มี
        .mockResolvedValueOnce({ id: 'probe-winner' }); // อ่านซ้ำหลังชน constraint
      prisma.probes.create.mockRejectedValue(p2002());

      await expect(service.resolveProbeId('dev-1', '3')).resolves.toBe('probe-winner');
    });

    it('P2002 แต่อ่านซ้ำแล้วยังไม่เจอ → โยนต่อ (เป็น constraint อื่น ไม่ใช่ race ที่คาดไว้)', async () => {
      prisma.probes.findUnique.mockResolvedValue(null);
      prisma.probes.create.mockRejectedValue(p2002());

      await expect(service.resolveProbeId('dev-1', '3')).rejects.toMatchObject({ code: 'P2002' });
    });

    it('error อื่นที่ไม่ใช่ P2002 โยนต่อทันที ไม่กลืน', async () => {
      prisma.probes.findUnique.mockResolvedValue(null);
      prisma.probes.create.mockRejectedValue(new Error('connection lost'));

      await expect(service.resolveProbeId('dev-1', '3')).rejects.toThrow('connection lost');
    });
  });
});
