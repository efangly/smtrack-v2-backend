import { Test, TestingModule } from '@nestjs/testing';
import { FirmwareController } from './firmware.controller';
import { FirmwareService } from './firmware.service';

describe('FirmwareController', () => {
  let controller: FirmwareController;
  let firmwareService: {
    create: jest.Mock;
    findAll: jest.Mock;
    findLatest: jest.Mock;
    findOne: jest.Mock;
    findByVersion: jest.Mock;
    getStream: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  const user = { id: 'user-1', name: 'Somchai', role: 'ADMIN', wardId: 'ward-1' };
  const req = { user } as never;
  const file = { originalname: 'app.bin' } as Express.Multer.File;

  beforeEach(async () => {
    firmwareService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findLatest: jest.fn(),
      findOne: jest.fn(),
      findByVersion: jest.fn(),
      getStream: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FirmwareController],
      providers: [{ provide: FirmwareService, useValue: firmwareService }],
    }).compile();

    controller = module.get(FirmwareController);
  });

  it('create ส่ง dto, ไฟล์ และ actor จาก JWT ให้ service', async () => {
    firmwareService.create.mockResolvedValue({ id: 'fw-1' });

    await controller.create({ version: '1.0.0', name: 'v1' }, req, file);

    expect(firmwareService.create).toHaveBeenCalledWith(
      { version: '1.0.0', name: 'v1' },
      file,
      user,
    );
  });

  it('findLatest เรียก service โดยไม่ต้องมี actor (public route)', async () => {
    firmwareService.findLatest.mockResolvedValue({ id: 'fw-1' });

    await controller.findLatest();

    expect(firmwareService.findLatest).toHaveBeenCalledWith();
  });

  it('update ส่ง id, dto, ไฟล์ และ actor ให้ service', async () => {
    firmwareService.update.mockResolvedValue({ id: 'fw-1' });

    await controller.update('fw-1', { name: 'renamed' }, req, file);

    expect(firmwareService.update).toHaveBeenCalledWith('fw-1', { name: 'renamed' }, file, user);
  });

  it('remove ส่ง id และ actor ให้ service', async () => {
    firmwareService.remove.mockResolvedValue({ id: 'fw-1' });

    await controller.remove('fw-1', req);

    expect(firmwareService.remove).toHaveBeenCalledWith('fw-1', user);
  });

  it('download ดึง firmware ด้วย version แล้ว pipe stream เข้า response พร้อม header ที่ถูกต้อง', async () => {
    const firmware = { fileName: 'app.bin', fileKey: 'firmware/abc.bin' };
    firmwareService.findByVersion.mockResolvedValue(firmware);
    const stream = { pipe: jest.fn() };
    firmwareService.getStream.mockResolvedValue(stream);
    const res = { setHeader: jest.fn() } as never;

    await controller.download('1.0.0', res);

    expect(firmwareService.findByVersion).toHaveBeenCalledWith('1.0.0');
    expect(firmwareService.getStream).toHaveBeenCalledWith(firmware);
    expect((res as { setHeader: jest.Mock }).setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="app.bin"',
    );
    expect(stream.pipe).toHaveBeenCalledWith(res);
  });
});
