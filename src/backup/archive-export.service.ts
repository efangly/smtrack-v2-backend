import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { to as copyTo } from 'pg-copy-streams';
import { createGzip } from 'node:zlib';
import { createHash, Hash } from 'node:crypto';
import { PassThrough, Transform, TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ObjectStorageService } from './object-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { PG_POOL } from './backup.tokens';
import { AppConfig } from '../config/configuration';
import {
  archiveObjectKey,
  isMonthString,
  metaObjectKey,
  monthRange,
  MonthString,
} from './archive.util';

export interface ArchiveMeta {
  month: MonthString;
  rowCount: number;
  sha256: string; // ของ CSV ก่อน gzip
  exportedAt: string;
  /**
   * ลำดับคอลัมน์ที่อยู่ในไฟล์ CSV
   *
   * COPY ... FROM STDIN อ่านไฟล์ตามลำดับคอลัมน์ที่ระบุใน statement ไม่ได้อ่านจากบรรทัด header
   * ถ้าไม่บันทึกไว้ พอ schema เพิ่มคอลัมน์ (device_id แล้วต่อมา probe_id) ไฟล์เก่าจะ restore ไม่ได้อีกเลย
   * ฟิลด์นี้ไม่มีในไฟล์ meta ที่ export ก่อนหน้านี้ ฝั่ง restore จึงต้อง fallback เป็นชุด legacy
   */
  columns?: readonly string[];
}

export const LOG_DAYS_COLUMNS = [
  'id',
  'serial',
  'temp',
  'temp_display',
  'humidity',
  'humidity_display',
  'send_time',
  'plug',
  'door1',
  'door2',
  'door3',
  'internet',
  'probe',
  'battery',
  'temp_internal',
  'ext_memory',
  'create_at',
  'update_at',
  'device_id',
  // ⚠️ คอลัมน์ใหม่ต้อง "ต่อท้าย" เท่านั้น ห้ามแทรกกลาง — ไฟล์เก่าที่ไม่มี meta.columns
  // ถูก restore ด้วยลำดับ legacy ที่ hardcode ไว้ การแทรกกลางทำให้ทุกไฟล์นั้น misalign
  'probe_id',
] as const;

/** Transform ที่นับจำนวนบรรทัดและคำนวณ sha256 ระหว่างที่ข้อมูลไหลผ่าน */
class CsvStats extends Transform {
  lines = 0;
  readonly hash: Hash = createHash('sha256');

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    for (const byte of chunk) if (byte === 0x0a) this.lines++;
    this.hash.update(chunk);
    cb(null, chunk);
  }
}

@Injectable()
export class ArchiveExportService {
  private readonly logger = new Logger(ArchiveExportService.name);

  constructor(
    private readonly storage: ObjectStorageService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig>,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /**
   * ตี 3 วันที่ 1 ของทุกเดือน — export เดือนที่อายุครบ (ARCHIVE_RETENTION_MONTHS - 1)
   * เหลือ buffer 1 เดือนก่อน TimescaleDB retention policy จะ drop chunk จริง
   */
  @Cron('0 3 1 * *')
  async exportDueMonth(): Promise<void> {
    const retentionMonths = this.config.get('archive.retentionMonths', { infer: true })!;
    const now = new Date();
    const target = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (retentionMonths - 1), 1),
    );
    const month = target.toISOString().slice(0, 7) as MonthString;
    try {
      await this.exportMonth(month);
    } catch (err) {
      this.logger.error(`export ${month} failed`, err as Error);
      throw err;
    }
  }

  /** export เดือนที่ระบุ (เรียกซ้ำได้ ปลอดภัย: เขียนทับ object เดิมแล้วตรวจใหม่) */
  async exportMonth(month: MonthString): Promise<ArchiveMeta> {
    if (!isMonthString(month)) {
      throw new Error(`รูปแบบเดือนไม่ถูกต้อง: "${month}" (ต้องเป็น YYYY-MM)`);
    }
    const { from, to } = monthRange(month);
    const key = archiveObjectKey(month);
    this.logger.log(`exporting ${month} -> s3://${this.storage.bucket}/${key}`);

    const client = await this.pool.connect();
    try {
      const columns = LOG_DAYS_COLUMNS.map((c) => `"${c}"`).join(', ');
      const copyStream = client.query(
        copyTo(
          `COPY (
             SELECT ${columns}
             FROM "log_days"
             WHERE "send_time" >= '${from.toISOString()}' AND "send_time" < '${to.toISOString()}'
             ORDER BY "serial", "send_time"
           ) TO STDOUT WITH (FORMAT csv, HEADER)`,
        ),
      );

      const stats = new CsvStats();
      const body = new PassThrough();
      const uploadDone = this.storage.uploadStream(key, body, 'application/gzip');
      await pipeline(copyStream, stats, createGzip({ level: 6 }), body);
      await uploadDone;

      const rowCount = Math.max(0, stats.lines - 1); // หัก header 1 บรรทัด

      const dbCount = await this.prisma.logDays.count({
        where: { sendTime: { gte: from, lt: to } },
      });
      if (dbCount !== rowCount) {
        await this.storage.delete(key); // อย่าปล่อยไฟล์ไม่ครบค้างไว้
        throw new Error(`row count mismatch for ${month}: db=${dbCount}, file=${rowCount}`);
      }

      const meta: ArchiveMeta = {
        month,
        rowCount,
        sha256: stats.hash.digest('hex'),
        exportedAt: new Date().toISOString(),
        columns: LOG_DAYS_COLUMNS,
      };
      await this.storage.putJson(metaObjectKey(month), meta);

      await this.prisma.archiveExport.upsert({
        where: { month: from },
        create: { month: from, rowCount: BigInt(rowCount), objectKey: key, sha256: meta.sha256 },
        update: {
          rowCount: BigInt(rowCount),
          objectKey: key,
          sha256: meta.sha256,
          exportedAt: new Date(),
        },
      });

      this.logger.log(`exported ${month}: ${rowCount} rows, sha256=${meta.sha256.slice(0, 12)}…`);
      return meta;
    } finally {
      client.release();
    }
  }
}
