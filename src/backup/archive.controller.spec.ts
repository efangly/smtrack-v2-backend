import { ArchiveController } from './archive.controller';
import { ArchiveExportService } from './archive-export.service';
import { ArchiveRestoreService } from './archive-restore.service';

describe('ArchiveController', () => {
  let controller: ArchiveController;
  let exporter: { exportMonth: jest.Mock };
  let restorer: { listAvailable: jest.Mock; restoreMonth: jest.Mock; removeMonth: jest.Mock };

  beforeEach(() => {
    exporter = { exportMonth: jest.fn().mockResolvedValue('export-result') };
    restorer = {
      listAvailable: jest.fn().mockResolvedValue('months-result'),
      restoreMonth: jest.fn().mockResolvedValue('restore-result'),
      removeMonth: jest.fn().mockResolvedValue('remove-result'),
    };
    controller = new ArchiveController(
      exporter as unknown as ArchiveExportService,
      restorer as unknown as ArchiveRestoreService,
    );
  });

  it('listMonths ส่งต่อไปยัง restorer.listAvailable', async () => {
    await expect(controller.listMonths()).resolves.toBe('months-result');
    expect(restorer.listAvailable).toHaveBeenCalledWith();
  });

  it('exportMonth ส่งต่อ month ไปยัง exporter.exportMonth', async () => {
    await expect(controller.exportMonth('2026-01')).resolves.toBe('export-result');
    expect(exporter.exportMonth).toHaveBeenCalledWith('2026-01');
  });

  it('restoreMonth ส่งต่อ month ไปยัง restorer.restoreMonth', async () => {
    await expect(controller.restoreMonth('2026-01')).resolves.toBe('restore-result');
    expect(restorer.restoreMonth).toHaveBeenCalledWith('2026-01');
  });

  it('removeMonth ส่งต่อ month ไปยัง restorer.removeMonth', async () => {
    await expect(controller.removeMonth('2026-01')).resolves.toBe('remove-result');
    expect(restorer.removeMonth).toHaveBeenCalledWith('2026-01');
  });
});
