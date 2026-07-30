import { Test, TestingModule } from '@nestjs/testing';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { DeviceService } from '../device/device.service';

describe('AuditController', () => {
  let controller: AuditController;
  let auditService: { findByDevice: jest.Mock };
  let deviceService: { findByStaticName: jest.Mock };

  beforeEach(async () => {
    auditService = { findByDevice: jest.fn() };
    deviceService = { findByStaticName: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        { provide: AuditService, useValue: auditService },
        { provide: DeviceService, useValue: deviceService },
      ],
    }).compile();

    controller = module.get(AuditController);
  });

  it('resolve staticName เป็น deviceId ก่อนดึงประวัติ audit', async () => {
    deviceService.findByStaticName.mockResolvedValue({ id: 'dev-1' });
    auditService.findByDevice.mockResolvedValue({ data: [{ id: 'audit-1' }], meta: {} });

    const pagination = { page: 1, limit: 20 };
    const result = await controller.findByDevice('OPD-01', pagination);

    expect(deviceService.findByStaticName).toHaveBeenCalledWith('OPD-01');
    expect(auditService.findByDevice).toHaveBeenCalledWith('dev-1', pagination);
    expect(result).toEqual({ data: [{ id: 'audit-1' }], meta: {} });
  });
});
