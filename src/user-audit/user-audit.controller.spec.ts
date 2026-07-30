import { Test, TestingModule } from '@nestjs/testing';
import { UserAuditController } from './user-audit.controller';
import { UserAuditService } from './user-audit.service';

describe('UserAuditController', () => {
  let controller: UserAuditController;
  let userAuditService: { findByActor: jest.Mock };

  beforeEach(async () => {
    userAuditService = { findByActor: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserAuditController],
      providers: [{ provide: UserAuditService, useValue: userAuditService }],
    }).compile();

    controller = module.get(UserAuditController);
  });

  it('findByActor เรียก service ด้วย actorId', async () => {
    userAuditService.findByActor.mockResolvedValue({ data: [{ id: 'audit-1' }], meta: {} });

    const pagination = { page: 1, limit: 20 };
    const result = await controller.findByActor('user-1', pagination);

    expect(userAuditService.findByActor).toHaveBeenCalledWith('user-1', pagination);
    expect(result).toEqual({ data: [{ id: 'audit-1' }], meta: {} });
  });
});
