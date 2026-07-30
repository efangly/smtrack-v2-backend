import { Test, TestingModule } from '@nestjs/testing';
import { UserAuditService } from './user-audit.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UserAuditService', () => {
  let service: UserAuditService;
  let prisma: { userAudit: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock } };

  const actor = { id: 'user-1', name: 'Somchai', role: 'ADMIN' };

  beforeEach(async () => {
    prisma = { userAudit: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UserAuditService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(UserAuditService);
  });

  it('record เขียน field ของ actor, entity และ snapshot ลง userAudit', async () => {
    prisma.userAudit.create.mockResolvedValue({ id: 'audit-1' });

    await service.record({
      entityType: 'probe',
      entityId: 'probe-1',
      action: 'updated',
      actor,
      snapshot: { id: 'probe-1' },
    });

    expect(prisma.userAudit.create).toHaveBeenCalledWith({
      data: {
        entityType: 'probe',
        entityId: 'probe-1',
        action: 'updated',
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        snapshot: { id: 'probe-1' },
      },
    });
  });

  it('record รองรับกรณีไม่มี actor (actor field เป็น undefined)', async () => {
    prisma.userAudit.create.mockResolvedValue({ id: 'audit-1' });

    await service.record({
      entityType: 'device',
      entityId: 'dev-1',
      action: 'created',
      snapshot: { id: 'dev-1' },
    });

    const call = prisma.userAudit.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data.actorId).toBeUndefined();
    expect(call.data.actorName).toBeUndefined();
    expect(call.data.actorRole).toBeUndefined();
  });

  it('findByActor คืนประวัติของ actor เรียงจากใหม่ไปเก่า พร้อม pagination meta', async () => {
    prisma.userAudit.findMany.mockResolvedValue([]);
    prisma.userAudit.count.mockResolvedValue(0);

    const result = await service.findByActor('user-1', { page: 1, limit: 50 });

    expect(prisma.userAudit.findMany).toHaveBeenCalledWith({
      where: { actorId: 'user-1' },
      orderBy: { createAt: 'desc' },
      skip: 0,
      take: 50,
    });
    expect(prisma.userAudit.count).toHaveBeenCalledWith({ where: { actorId: 'user-1' } });
    expect(result.meta).toEqual({ page: 1, limit: 50, total: 0, totalPages: 0 });
  });
});
