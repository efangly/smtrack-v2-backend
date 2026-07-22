import { ConfigService } from '@nestjs/config';
import { ObjectStorageService } from './object-storage.service';
import { AppConfig } from '../config/configuration';

const send = jest.fn();
const uploadDone = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send })),
  GetObjectCommand: jest
    .fn()
    .mockImplementation((input) => ({ __type: 'GetObjectCommand', input })),
  HeadObjectCommand: jest
    .fn()
    .mockImplementation((input) => ({ __type: 'HeadObjectCommand', input })),
  ListObjectsV2Command: jest
    .fn()
    .mockImplementation((input) => ({ __type: 'ListObjectsV2Command', input })),
  DeleteObjectCommand: jest
    .fn()
    .mockImplementation((input) => ({ __type: 'DeleteObjectCommand', input })),
  PutObjectCommand: jest
    .fn()
    .mockImplementation((input) => ({ __type: 'PutObjectCommand', input })),
}));

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation((opts) => ({ done: () => uploadDone(opts) })),
}));

describe('ObjectStorageService', () => {
  let service: ObjectStorageService;
  const config = {
    get: (key: string) => {
      if (key === 'archive.s3') {
        return {
          endpoint: 'http://nas.local:9000',
          accessKey: 'ak',
          secretKey: 'sk',
          bucket: 'smtrack-log-archive',
          forcePathStyle: true,
          region: 'us-east-1',
        };
      }
      return undefined;
    },
  } as unknown as ConfigService<AppConfig>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ObjectStorageService(config);
  });

  it('อ่าน bucket จาก config', () => {
    expect(service.bucket).toBe('smtrack-log-archive');
  });

  it('uploadStream ส่งผ่าน Upload ด้วย bucket/key/body/contentType ที่ถูกต้อง', async () => {
    uploadDone.mockResolvedValue(undefined);
    const body = {} as any;
    await service.uploadStream(
      'log-days/2026/01/log-days-2026-01.csv.gz',
      body,
      'application/gzip',
    );

    expect(uploadDone).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          Bucket: 'smtrack-log-archive',
          Key: 'log-days/2026/01/log-days-2026-01.csv.gz',
          Body: body,
          ContentType: 'application/gzip',
        },
      }),
    );
  });

  it('putJson เขียน JSON เป็น body พร้อม content-type', async () => {
    send.mockResolvedValue({});
    await service.putJson('k.json', { a: 1 });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: 'smtrack-log-archive',
          Key: 'k.json',
          Body: JSON.stringify({ a: 1 }, null, 2),
          ContentType: 'application/json',
        }),
      }),
    );
  });

  it('exists คืน true เมื่อ HeadObject สำเร็จ', async () => {
    send.mockResolvedValue({});
    await expect(service.exists('k')).resolves.toBe(true);
  });

  it('exists คืน false เมื่อ HeadObject ล้มเหลว', async () => {
    send.mockRejectedValue(new Error('not found'));
    await expect(service.exists('k')).resolves.toBe(false);
  });

  it('list วนหน้าตาม ContinuationToken จนครบ', async () => {
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'a', Size: 1 }],
        IsTruncated: true,
        NextContinuationToken: 'tok-1',
      })
      .mockResolvedValueOnce({ Contents: [{ Key: 'b', Size: 2 }], IsTruncated: false });

    const result = await service.list('log-days/');

    expect(result).toEqual([
      { key: 'a', size: 1 },
      { key: 'b', size: 2 },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('delete เรียก DeleteObjectCommand ด้วย key ที่ระบุ', async () => {
    send.mockResolvedValue({});
    await service.delete('k');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ input: { Bucket: 'smtrack-log-archive', Key: 'k' } }),
    );
  });
});
