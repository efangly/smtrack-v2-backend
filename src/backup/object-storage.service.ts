import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { AppConfig } from '../config/configuration';

/**
 * ชั้นเดียวที่คุยกับ object storage — ใช้ AWS SDK มาตรฐาน
 * MinIO (self-hosted): ตั้ง ARCHIVE_S3_ENDPOINT + ARCHIVE_S3_FORCE_PATH_STYLE=true
 * ย้ายไป AWS S3 จริง: ลบ ARCHIVE_S3_ENDPOINT ออก, FORCE_PATH_STYLE=false
 * โค้ดส่วนอื่นไม่ต้องแก้แม้แต่บรรทัดเดียว
 */
@Injectable()
export class ObjectStorageService {
  private readonly logger = new Logger(ObjectStorageService.name);
  readonly bucket: string;
  private readonly s3: S3Client;

  constructor(config: ConfigService<AppConfig>) {
    const s3Config = config.get('archive.s3', { infer: true })!;
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

  /** อัปโหลดแบบ stream (multipart อัตโนมัติ) — ไม่ buffer ทั้งไฟล์ในหน่วยความจำ */
  async uploadStream(key: string, body: Readable, contentType: string): Promise<void> {
    const upload = new Upload({
      client: this.s3,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType },
    });
    await upload.done();
    this.logger.log(`uploaded s3://${this.bucket}/${key}`);
  }

  async putJson(key: string, data: unknown): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(data, null, 2),
        ContentType: 'application/json',
      }),
    );
  }

  async getStream(key: string): Promise<Readable> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }

  async getJson<T>(key: string): Promise<T> {
    const stream = await this.getStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) out.push({ key: obj.Key, size: obj.Size ?? 0 });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    this.logger.log(`deleted s3://${this.bucket}/${key}`);
  }
}
