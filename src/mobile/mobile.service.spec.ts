import { MobileService } from './mobile.service';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** ผู้ใช้ใน tenant T1 — SUPER เห็นทุก tenant, departments 'ALL' = เห็นทั้ง tenant */
const userIn = (role: string, departments: 'ALL' | string[] = 'ALL'): JwtPayloadDto => ({
  id: 'u1',
  name: 'user',
  role,
  scope: role === 'SUPER' ? { kind: 'GLOBAL' } : { kind: 'TENANT', tenantId: 'T1', departments },
});

describe('MobileService', () => {
  let service: MobileService;
  let prisma: { devices: { findMany: jest.Mock }; notifications: { findMany: jest.Mock } };
  let redis: { getOrSet: jest.Mock };

  beforeEach(() => {
    prisma = {
      devices: { findMany: jest.fn().mockResolvedValue([]) },
      notifications: { findMany: jest.fn().mockResolvedValue([]) },
    };
    redis = { getOrSet: jest.fn().mockImplementation((_key, _ttl, factory) => factory()) };
    service = new MobileService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
    );
  });

  describe('findByDepartment', () => {
    it('AND department ที่ขอกับ scope — ไม่ให้ department ที่ขอทับเงื่อนไขของ scope', async () => {
      await service.findByDepartment('ICU', userIn('USER', ['OPD', 'ICU']));

      expect(prisma.devices.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { tenantId: 'T1', departmentId: { in: ['OPD', 'ICU'] } },
              { departmentId: 'ICU' },
            ],
          },
        }),
      );
    });

    it('ผู้ที่เห็นทั้ง tenant ได้เฉพาะ department นั้นใน tenant ตัวเอง (ชื่อซ้ำใน tenant อื่นไม่ติดมา)', async () => {
      await service.findByDepartment('ER', userIn('ADMIN'));

      expect(prisma.devices.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { AND: [{ tenantId: 'T1' }, { departmentId: 'ER' }] } }),
      );
    });

    it('cache แยกตาม scope — ผลของ tenant หนึ่งไม่หลุดไปให้อีก tenant', async () => {
      await service.findByDepartment('OPD', userIn('ADMIN'));
      await service.findByDepartment('OPD', userIn('SUPER'));

      const [first, second] = redis.getOrSet.mock.calls.map(([key]) => key);
      expect(first).not.toBe(second);
    });
  });

  describe('findNotification', () => {
    it('ผู้ที่ถูก scope เห็นเฉพาะ notification ใน scope และ cache แยกตามชุด department', async () => {
      await service.findNotification(userIn('USER', ['OPD', 'ICU']));
      await service.findNotification(userIn('USER', ['ICU', 'OPD']));
      await service.findNotification(userIn('USER', ['ER']));

      expect(prisma.notifications.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { device: { tenantId: 'T1', departmentId: { in: ['OPD', 'ICU'] } } },
        }),
      );
      const keys = redis.getOrSet.mock.calls.map(([key]) => key);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[0]).not.toBe(keys[2]);
    });

    it('GLOBAL ไม่กรอง', async () => {
      await service.findNotification(userIn('SUPER'));

      expect(prisma.notifications.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
    });
  });
});
