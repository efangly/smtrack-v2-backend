import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { ObjectStorageService } from './object-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { PG_POOL } from './backup.tokens';
import { AppConfig } from '../config/configuration';
import { ArchiveMeta } from './archive-export.service';
import {
  archiveObjectKey,
  isMonthString,
  metaObjectKey,
  monthRange,
  MonthString,
} from './archive.util';

export interface RestoreResult {
  month: MonthString;
  rowCount: number;
  objectKey: string;
}

/**
 * ลำดับคอลัมน์ของไฟล์ที่ export ไว้ "ก่อน" จะมีคอลัมน์ device_id
 * ใช้เมื่อไฟล์ meta ไม่มีฟิลด์ `columns` (ไฟล์เก่า) — ห้ามแก้ลำดับนี้ ไม่งั้น backup เก่าจะ restore ไม่ได้
 */
const LEGACY_LOG_DAY_ARCHIVE_COLUMNS = [
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
] as const;

@Injectable()
export class ArchiveRestoreService {
  private readonly logger = new Logger(ArchiveRestoreService.name);

  constructor(
    private readonly storage: ObjectStorageService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig>,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /** เดือนที่มี backup ใน object storage พร้อมให้ restore */
  async listAvailable(): Promise<{ month: string; sizeBytes: number; restored: boolean }[]> {
    const [objects, restored] = await Promise.all([
      this.storage.list('log-days/'),
      this.prisma.archiveRestore.findMany({ select: { month: true } }),
    ]);
    const restoredSet = new Set(restored.map((r) => r.month.toISOString().slice(0, 7)));

    return objects
      .filter((o) => o.key.endsWith('.csv.gz'))
      .map((o) => {
        const m = o.key.match(/log-days-(\d{4}-\d{2})\.csv\.gz$/);
        return m ? { month: m[1], sizeBytes: o.size, restored: restoredSet.has(m[1]) } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.month.localeCompare(b.month));
  }

  /**
   * ดึงข้อมูลเดือนที่ระบุจาก object storage กลับเข้า LogDayArchive
   * ทั้งเดือนเป็น transaction เดียว: สำเร็จทั้งเดือนหรือไม่เข้าเลย
   */
  async restoreMonth(month: MonthString): Promise<RestoreResult> {
    this.assertValidMonth(month);
    const { from, to } = monthRange(month);

    // กัน restore เดือนที่ raw data ยังอยู่ใน log_days (จะทำให้ view log_days_all ซ้ำ)
    const retentionMonths = this.config.get('archive.retentionMonths', { infer: true })!;
    const retentionEdge = new Date();
    retentionEdge.setUTCMonth(retentionEdge.getUTCMonth() - retentionMonths);
    if (to > retentionEdge) {
      throw new BadRequestException(
        `เดือน ${month} ยังอยู่ใน retention window — query จากตาราง log_days ได้โดยตรง`,
      );
    }

    const already = await this.prisma.archiveRestore.findUnique({ where: { month: from } });
    if (already) {
      throw new ConflictException(`เดือน ${month} ถูก restore ไว้แล้ว (${already.rowCount} rows)`);
    }

    const key = archiveObjectKey(month);
    if (!(await this.storage.exists(key))) {
      throw new NotFoundException(`ไม่พบ backup ของเดือน ${month} (${key})`);
    }

    // ต้องอ่าน meta ก่อน COPY เพราะลำดับคอลัมน์ของไฟล์ถูกกำหนดจาก meta.columns
    // ไฟล์ที่ export ไว้ก่อนมีคอลัมน์ device_id จะไม่มีฟิลด์นี้ จึงถอยไปใช้ชุด legacy
    const meta = (await this.storage.exists(metaObjectKey(month)))
      ? await this.storage.getJson<ArchiveMeta>(metaObjectKey(month))
      : undefined;
    const fileColumns = meta?.columns ?? LEGACY_LOG_DAY_ARCHIVE_COLUMNS;

    this.logger.log(`restoring ${month} from s3://${this.storage.bucket}/${key}`);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const columns = fileColumns.map((c) => `"${c}"`).join(', ');
      const ingest = client.query(
        copyFrom(`COPY "log_day_archive" (${columns}) FROM STDIN WITH (FORMAT csv, HEADER)`),
      );
      const objectStream = await this.storage.getStream(key);
      await pipeline(objectStream, createGunzip(), ingest);
      const rowCount = Number(ingest.rowCount ?? 0);

      // ตรวจกับ metadata ที่เขียนไว้ตอน export (ถ้ามี)
      if (meta && meta.rowCount !== rowCount) {
        throw new Error(`restore ${month} mismatch: meta=${meta.rowCount}, inserted=${rowCount}`);
      }

      await client.query(
        `INSERT INTO "archive_restore" ("month", "row_count", "object_key") VALUES ($1, $2, $3)`,
        [from, rowCount, key],
      );
      await client.query('COMMIT');

      this.logger.log(`restored ${month}: ${rowCount} rows`);
      return { month, rowCount, objectKey: key };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** ใช้เสร็จแล้วเคลียร์ออก — ข้อมูลตัวจริงยังอยู่บน object storage เสมอ */
  async removeMonth(month: MonthString): Promise<{ month: MonthString; removedRows: number }> {
    this.assertValidMonth(month);
    const { from, to } = monthRange(month);

    const record = await this.prisma.archiveRestore.findUnique({ where: { month: from } });
    if (!record) throw new NotFoundException(`เดือน ${month} ไม่ได้ถูก restore อยู่`);

    // chunk interval = 1 เดือน — การลบทั้งเดือนจึงเท่ากับ drop chunk เดียว เร็วมาก
    const res = await this.pool.query(
      'DELETE FROM "log_day_archive" WHERE "send_time" >= $1 AND "send_time" < $2',
      [from, to],
    );
    await this.prisma.archiveRestore.delete({ where: { month: from } });

    return { month, removedRows: res.rowCount ?? 0 };
  }

  private assertValidMonth(month: string): asserts month is MonthString {
    if (!isMonthString(month)) {
      throw new BadRequestException(`รูปแบบเดือนไม่ถูกต้อง: "${month}" (ต้องเป็น YYYY-MM)`);
    }
  }
}
