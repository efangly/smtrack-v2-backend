import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ArchiveStatusService } from '../backup/archive-status.service';

describe('HealthController /health/archive', () => {
  const make = (status: unknown) =>
    new HealthController(
      {} as never,
      {} as never,
      {} as never,
      { getStatus: jest.fn().mockResolvedValue(status) } as unknown as ArchiveStatusService,
    );
  const base = { checkedAt: new Date(), lastSuccessfulRunAt: null, tables: [] };

  it('healthy: 200 พร้อมสถานะ ok', async () => {
    const res = await make({ ...base, healthy: true, reasons: [] }).archive();
    expect(res.status).toBe('ok');
  });

  it('degraded: 503 พร้อมสาเหตุในข้อความ', async () => {
    await expect(
      make({ ...base, healthy: false, reasons: ['log_days: ค้าง 2026-05'] }).archive(),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(
      make({ ...base, healthy: false, reasons: ['log_days: ค้าง 2026-05'] }).archive(),
    ).rejects.toThrow(/log_days: ค้าง 2026-05/);
  });
});
