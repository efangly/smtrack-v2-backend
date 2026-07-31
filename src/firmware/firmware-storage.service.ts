import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { AppConfig } from '../config/configuration';

/** อัปโหลด/ดาวน์โหลดไฟล์ firmware ขึ้น object storage — bucket/credentials แยกจาก archive/device */
@Injectable()
export class FirmwareStorageService {
  private readonly logger = new Logger(FirmwareStorageService.name);
  private readonly bucket: string;
  private readonly s3: S3Client;

  constructor(config: ConfigService<AppConfig>) {
    const s3Config = config.get('firmware.s3', { infer: true })!;
    this.bucket = s3Config.bucket;
    this.s3 = new S3Client({
      region: s3Config.region,
      endpoint: s3Config.endpoint,
      forcePathStyle: s3Config.forcePathStyle,
      credentials: {
        accessKeyId: s3Config.accessKey,
        secretAccessKey: s3Config.secretKey,
      },
    });
  }

  async upload(key: string, body: Buffer, contentType: string): Promise<string> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
    this.logger.log(`uploaded s3://${this.bucket}/${key}`);
    return key;
  }

  async delete(key: string): Promise<void> {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      this.logger.log(`deleted s3://${this.bucket}/${key}`);
    } catch (err) {
      this.logger.warn(`failed to delete s3://${this.bucket}/${key}: ${(err as Error).message}`);
    }
  }

  /** ดึงไฟล์กลับมาเป็น stream เพื่อ pipe ตรงไปยัง HTTP response — อุปกรณ์ดาวน์โหลดไฟล์ตรงจากที่นี่ */
  async getStream(key: string): Promise<Readable> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }
}
