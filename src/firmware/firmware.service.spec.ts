import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { FirmwareService } from './firmware.service';
import { FirmwareStorageService } from './firmware-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppEvents } from '../common/events/app-events';

describe('FirmwareService', () => {
  let service: FirmwareService;
  let prisma: {
    firmwares: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      count: jest.Mock;
    };
  };
  let storage: { upload: jest.Mock; delete: jest.Mock; getStream: jest.Mock };
  let events: { emit: jest.Mock };

  const actor = { id: 'user-1', name: 'Somchai', role: 'ADMIN' };
  const firmware = { id: 'fw-1', version: '1.0.0', name: 'v1', fileKey: 'firmware/abc.bin' };
  const file = {
    originalname: 'app.bin',
    mimetype: 'application/octet-stream',
    buffer: Buffer.from('data'),
    size: 4,
  } as Express.Multer.File;

  beforeEach(async () => {
    prisma = {
      firmwares: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
    };
    storage = {
      upload: jest.fn().mockResolvedValue('firmware/abc.bin'),
      delete: jest.fn(),
      getStream: jest.fn(),
    };
    events = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FirmwareService,
        { provide: PrismaService, useValue: prisma },
        { provide: FirmwareStorageService, useValue: storage },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();

    service = module.get(FirmwareService);
  });

  it('create อัปโหลดไฟล์แล้วบันทึก metadata พร้อม emit firmware.changed (created)', async () => {
    prisma.firmwares.create.mockResolvedValue(firmware);

    const result = await service.create({ version: '1.0.0', name: 'v1' }, file, actor);

    expect(storage.upload).toHaveBeenCalledWith(
      expect.stringContaining('firmware/'),
      file.buffer,
      file.mimetype,
    );
    expect(prisma.firmwares.create).toHaveBeenCalledWith({
      data: {
        version: '1.0.0',
        name: 'v1',
        fileKey: 'firmware/abc.bin',
        fileName: 'app.bin',
        fileSize: 4,
      },
    });
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.FIRMWARE_CHANGED,
      expect.objectContaining({ action: 'created', firmwareId: 'fw-1', actor }),
    );
    expect(result).toEqual(firmware);
  });

  it('create ลบไฟล์ที่อัปโหลดไปแล้วออกจาก S3 ถ้าบันทึก DB ล้มเหลว (rollback)', async () => {
    prisma.firmwares.create.mockRejectedValue(new Error('db fail'));

    await expect(service.create({ version: '1.0.0', name: 'v1' }, file, actor)).rejects.toThrow(
      'db fail',
    );

    expect(storage.delete).toHaveBeenCalledWith('firmware/abc.bin');
  });

  it('findOne โยน NotFoundException ถ้าไม่พบ firmware', async () => {
    prisma.firmwares.findUnique.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('findLatest โยน NotFoundException ถ้ายังไม่มี firmware เลย', async () => {
    prisma.firmwares.findFirst.mockResolvedValue(null);

    await expect(service.findLatest()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('findLatest เรียงจากใหม่ไปเก่าแล้วเอาตัวแรก', async () => {
    prisma.firmwares.findFirst.mockResolvedValue(firmware);

    const result = await service.findLatest();

    expect(prisma.firmwares.findFirst).toHaveBeenCalledWith({ orderBy: { createAt: 'desc' } });
    expect(result).toEqual(firmware);
  });

  it('findByVersion โยน NotFoundException ถ้าไม่พบเวอร์ชั่นนั้น', async () => {
    prisma.firmwares.findUnique.mockResolvedValue(null);

    await expect(service.findByVersion('9.9.9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update ตัด version ออกจาก dto ก่อนเขียน แล้ว emit firmware.changed (updated)', async () => {
    prisma.firmwares.update.mockResolvedValue(firmware);

    await service.update('fw-1', { version: '9.9.9', name: 'renamed' }, undefined, actor);

    expect(prisma.firmwares.update).toHaveBeenCalledWith({
      where: { id: 'fw-1' },
      data: { name: 'renamed' },
    });
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.FIRMWARE_CHANGED,
      expect.objectContaining({ action: 'updated' }),
    );
  });

  it('update แทนที่ไฟล์เดิมด้วยไฟล์ใหม่แล้วลบไฟล์เก่าออกจาก S3 หลังสำเร็จ', async () => {
    prisma.firmwares.findUnique.mockResolvedValue({ ...firmware, fileKey: 'firmware/old.bin' });
    prisma.firmwares.update.mockResolvedValue(firmware);

    await service.update('fw-1', { name: 'v1' }, file, actor);

    expect(storage.upload).toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledWith('firmware/old.bin');
  });

  it('remove ลบ record แล้วลบไฟล์ออกจาก S3 พร้อม emit firmware.changed (deleted)', async () => {
    prisma.firmwares.delete.mockResolvedValue(firmware);

    const result = await service.remove('fw-1', actor);

    expect(prisma.firmwares.delete).toHaveBeenCalledWith({ where: { id: 'fw-1' } });
    expect(storage.delete).toHaveBeenCalledWith('firmware/abc.bin');
    expect(events.emit).toHaveBeenCalledWith(
      AppEvents.FIRMWARE_CHANGED,
      expect.objectContaining({ action: 'deleted' }),
    );
    expect(result).toEqual(firmware);
  });
});
