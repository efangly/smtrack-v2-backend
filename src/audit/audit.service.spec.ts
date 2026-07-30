import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from './audit.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AuditService', () => {
  let service: AuditService;
  let prisma: {
    deviceAudit: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock };
  };

  const actor = { id: 'user-1', name: 'Somchai', role: 'ADMIN' };

  beforeEach(async () => {
    prisma = { deviceAudit: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AuditService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(AuditService);
  });

  it('record เขียน field ของ actor และ snapshot ลง deviceAudit', async () => {
    prisma.deviceAudit.create.mockResolvedValue({ id: 'audit-1' });

    await service.record({
      deviceId: 'dev-1',
      staticName: 'OPD-01',
      action: 'updated',
      actor,
      snapshot: { id: 'dev-1' },
    });

    expect(prisma.deviceAudit.create).toHaveBeenCalledWith({
      data: {
        deviceId: 'dev-1',
        staticName: 'OPD-01',
        action: 'updated',
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        snapshot: { id: 'dev-1' },
      },
    });
  });

  it('record รองรับกรณีไม่มี actor (actor field เป็น undefined)', async () => {
    prisma.deviceAudit.create.mockResolvedValue({ id: 'audit-1' });

    await service.record({
      deviceId: 'dev-1',
      staticName: 'OPD-01',
      action: 'created',
      snapshot: { id: 'dev-1' },
    });

    const call = prisma.deviceAudit.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data.actorId).toBeUndefined();
    expect(call.data.actorName).toBeUndefined();
    expect(call.data.actorRole).toBeUndefined();
  });

  it('findByDevice คืนประวัติเรียงจากใหม่ไปเก่า พร้อม pagination meta', async () => {
    prisma.deviceAudit.findMany.mockResolvedValue([]);
    prisma.deviceAudit.count.mockResolvedValue(0);

    const result = await service.findByDevice('dev-1', { page: 1, limit: 50 });

    expect(prisma.deviceAudit.findMany).toHaveBeenCalledWith({
      where: { deviceId: 'dev-1' },
      orderBy: { createAt: 'desc' },
      skip: 0,
      take: 50,
    });
    expect(prisma.deviceAudit.count).toHaveBeenCalledWith({ where: { deviceId: 'dev-1' } });
    expect(result.meta).toEqual({ page: 1, limit: 50, total: 0, totalPages: 0 });
  });
});
