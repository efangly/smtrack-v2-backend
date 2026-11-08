import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { ArchiveExportService } from './archive-export.service';
import { RestoredWindowService } from './restored-window.service';
import { ObjectStorageService } from './object-storage.service';
import { CsvStats } from './csv-stats';
import { ARCHIVE_TABLES, ArchiveTable } from './archive-tables';
import { hotWindowStart, metaObjectKey, monthRange, MonthString } from './archive.util';
import { describeError } from './describe-error';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../config/configuration';

export type ArchiveJobName = 'export-and-drop' | 'cleanup-restored' | 'backfill' | 'verify';

/** ช่วงเดือน (รวมทั้งสองปลาย) สำหรับ backfill/verify — ไม่ระบุ = ไม่จำกัดด้านนั้น */
export interface MonthRange {
  from?: MonthString;
  to?: MonthString;
}

const inRange = (m: MonthString, r: MonthRange): boolean =>
  (!r.from || m >= r.from) && (!r.to || m <= r.to);

export interface JobOptions {
  /** แสดงสิ่งที่จะทำโดยไม่ export/ลบจริง และไม่เขียน archive_job_run */
  dryRun?: boolean;
  now?: Date;
}

export interface JobOutcome {
  /** false = มีอย่างน้อยหนึ่งขั้นล้มเหลว → CLI ต้อง exit ≠ 0 */
  ok: boolean;
  /** true = มี instance อื่นของงานนี้กำลังรันอยู่ (advisory lock) จึงไม่ทำอะไร */
  skipped: boolean;
  failures: string[];
}

/**
 * ตัวควบคุมงาน archive ที่ถูกเรียกจาก CLI (k8s CronJob — ADR-0006)
 *
 * - ล็อกด้วย pg_try_advisory_lock กันรันซ้อนทั้งจาก CronJob ซ้ำและจากการสั่งรันมือ
 * - บันทึกทุกขั้นลง archive_job_run เพื่อให้ตรวจย้อนหลังได้โดยไม่พึ่ง history ของ k8s Job
 */
@Injectable()
export class ArchiveJobService {
  private readonly logger = new Logger(ArchiveJobService.name);

  constructor(
    private readonly exporter: ArchiveExportService,
    private readonly restored: RestoredWindowService,
    private readonly storage: ObjectStorageService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig>,
  ) {}

  /** export ทุกเดือนที่ค้าง แล้วลบ chunk ที่ออกจาก hot window และมี archive ยืนยันแล้ว */
  async runExportAndDrop(
    options: JobOptions & { tables?: readonly ArchiveTable[] } = {},
  ): Promise<JobOutcome> {
    const now = options.now ?? new Date();
    const tables = options.tables ?? ARCHIVE_TABLES;

    return this.withLock('export-and-drop', options.dryRun ?? false, async () => {
      const failures: string[] = [];

      for (const table of tables) {
        if (options.dryRun) {
          const { cutoff, pending } = await this.exporter.planDrop(table, now);
          this.logger.log(
            `[dry-run] ${table}: pending=[${pending.join(', ')}] would drop chunks older than ${cutoff.toISOString()}`,
          );
          continue;
        }

        for (const month of await this.exporter.findPendingMonths(table, now)) {
          const runId = await this.startRun('export-and-drop', table, month);
          try {
            const meta = await this.exporter.exportMonth(month, table);
            await this.finishRun(runId, 'succeeded', {
              rowCount: meta.rowCount,
              sha256: meta.sha256,
            });
          } catch (err) {
            const message = errorMessage(err);
            this.logger.error(`export ${table} ${month} failed: ${message}`);
            await this.finishRun(runId, 'failed', { error: message });
            failures.push(`export ${table} ${month}: ${message}`);
          }
        }

        // เดือนที่ export ล้มเหลวยังเป็น pending → dropVerifiedChunks ถอย cutoff ไปก่อนเดือนนั้นเอง
        const dropRunId = await this.startRun('export-and-drop', table, null);
        try {
          const dropped = await this.exporter.dropVerifiedChunks(table, now);
          await this.finishRun(dropRunId, 'succeeded', { rowCount: dropped.droppedChunks });
        } catch (err) {
          const message = errorMessage(err);
          this.logger.error(`drop ${table} failed: ${message}`);
          await this.finishRun(dropRunId, 'failed', { error: message });
          failures.push(`drop ${table}: ${message}`);
        }
      }

      return failures;
    });
  }

  /**
   * ก่อน cut-over (ADR-0005): archive ข้อมูลที่ค้างอยู่ใน DB ทุกเดือนที่จบแล้ว "โดยไม่ลบอะไร"
   *
   * ต่างจาก export-and-drop ตรงที่ไม่เรียก dropVerifiedChunks เลย และจำกัดช่วงเดือน/ตารางได้
   * ใช้ล็อกเดียวกับ export-and-drop จึงไม่ซ้อนกับ CronJob — เรียก exportMonth ตัวเดียวกัน
   * (ตรวจ row count, เขียน staging แล้วค่อย promote, บันทึก archive_export) ไม่มี logic export แยก
   */
  async runBackfill(
    options: JobOptions & MonthRange & { tables?: readonly ArchiveTable[] } = {},
  ): Promise<JobOutcome> {
    const now = options.now ?? new Date();
    const tables = options.tables ?? ARCHIVE_TABLES;

    return this.withLock(
      'backfill',
      options.dryRun ?? false,
      async () => {
        const failures: string[] = [];
        let totalMonths = 0;
        let totalRows = 0;

        for (const table of tables) {
          const months = (await this.exporter.findPendingMonths(table, now)).filter((m) =>
            inRange(m, options),
          );
          if (months.length === 0) {
            this.logger.log(`backfill ${table}: nothing to archive`);
            continue;
          }

          for (const month of months) {
            if (options.dryRun) {
              const rows = await this.exporter.countMonth(table, month);
              totalMonths += 1;
              totalRows += rows;
              this.logger.log(`[dry-run] backfill ${table} ${month}: ${rows} rows in database`);
              continue;
            }
            const runId = await this.startRun('backfill', table, month);
            try {
              const meta = await this.exporter.exportMonth(month, table);
              totalMonths += 1;
              totalRows += meta.rowCount;
              await this.finishRun(runId, 'succeeded', {
                rowCount: meta.rowCount,
                sha256: meta.sha256,
              });
            } catch (err) {
              const message = errorMessage(err);
              this.logger.error(`backfill ${table} ${month} failed: ${message}`);
              await this.finishRun(runId, 'failed', { error: message });
              failures.push(`backfill ${table} ${month}: ${message}`);
            }
          }
        }

        this.logger.log(
          `${options.dryRun ? '[dry-run] would archive' : 'archived'} ${totalMonths} month(s), ${totalRows} row(s) — nothing was dropped`,
        );
        return failures;
      },
      'export-and-drop',
    );
  }

  /**
   * ตรวจว่า "พร้อม cut-over" ไหม (อ่านอย่างเดียว ไม่แก้อะไร):
   *  1. ไฟล์ของทุก archive_export ยังอยู่บน object storage
   *  2. อ่านไฟล์กลับมาแล้ว จำนวน record และ sha256 ตรงกับที่บันทึกไว้ตอน export (ไม่เชื่อแค่ตัวเลขใน DB)
   *  3. ไม่มีเดือนที่เก่ากว่า hot window ค้างอยู่ในฐานข้อมูลโดยไม่มี archive ที่ใช้ได้
   * ผ่านทั้งสามข้อ = ถอด add_retention_policy ได้ (เดือนก่อนหน้าที่ยังอยู่ใน hot window ไม่นับ — cron วันที่ 1 จัดการ)
   */
  async runVerify(
    options: JobOptions & MonthRange & { tables?: readonly ArchiveTable[] } = {},
  ): Promise<JobOutcome> {
    const now = options.now ?? new Date();
    const tables = options.tables ?? ARCHIVE_TABLES;

    return this.withLock('verify', false, async () => {
      const failures: string[] = [];
      let checked = 0;

      for (const table of tables) {
        const records = await this.prisma.archiveExport.findMany({
          where: { sourceTable: table },
          orderBy: { month: 'asc' },
        });
        for (const rec of records) {
          const month = rec.month.toISOString().slice(0, 7) as MonthString;
          if (!inRange(month, options)) continue;

          checked += 1;
          const runId = await this.startRun('verify', table, month);
          const problem = await this.verifyOne(table, month, rec);
          if (problem) {
            this.logger.error(`verify ${table} ${month}: ${problem}`);
            await this.finishRun(runId, 'failed', { error: problem });
            failures.push(`verify ${table} ${month}: ${problem}`);
          } else {
            await this.finishRun(runId, 'succeeded', {
              rowCount: Number(rec.rowCount),
              sha256: rec.sha256,
            });
          }
        }

        const boundary = hotWindowStart(now);
        const uncovered = (await this.exporter.findPendingMonths(table, now)).filter(
          (m) => inRange(m, options) && monthRange(m).from < boundary,
        );
        for (const month of uncovered) {
          failures.push(`coverage ${table} ${month}: still in database with no usable archive`);
          this.logger.error(`coverage ${table} ${month}: still in database with no usable archive`);
        }
      }

      this.logger.log(
        failures.length === 0
          ? `verify: ${checked} archive(s) intact, every month older than the hot window is archived — CUT-OVER READY`
          : `verify: ${failures.length} problem(s) — NOT ready to remove add_retention_policy`,
      );
      return failures;
    });
  }

  /** null = ผ่าน, ไม่เช่นนั้นคือเหตุผลที่ไม่ผ่าน */
  private async verifyOne(
    table: ArchiveTable,
    month: MonthString,
    rec: { objectKey: string; rowCount: bigint; sha256: string },
  ): Promise<string | null> {
    try {
      if (!(await this.storage.exists(rec.objectKey))) return `object missing: ${rec.objectKey}`;
      if (!(await this.storage.exists(metaObjectKey(month, table)))) {
        return `meta missing: ${metaObjectKey(month, table)}`;
      }
      const stats = new CsvStats();
      await pipeline(
        await this.storage.getStream(rec.objectKey),
        createGunzip(),
        stats,
        async (src) => {
          for await (const _chunk of src) void _chunk;
        },
      );
      if (stats.rowCount !== Number(rec.rowCount)) {
        return `row count: file has ${stats.rowCount}, archive_export says ${rec.rowCount}`;
      }
      const sha = stats.hash.digest('hex');
      if (sha !== rec.sha256)
        return `sha256 differs: file ${sha.slice(0, 12)}…, recorded ${rec.sha256.slice(0, 12)}…`;
      return null;
    } catch (err) {
      return `unreadable: ${errorMessage(err)}`;
    }
  }

  /** ลบข้อมูลที่ on-demand restore ไว้และหมดอายุ (TTL 24 ชม. นับจากการอ่านล่าสุด) */
  async runCleanupRestored(options: JobOptions = {}): Promise<JobOutcome> {
    return this.withLock('cleanup-restored', options.dryRun ?? false, async () => {
      if (options.dryRun) {
        this.logger.log('[dry-run] cleanup-restored: would remove expired restored windows');
        return [];
      }
      const runId = await this.startRun('cleanup-restored', 'log_days', null);
      try {
        const res = await this.restored.cleanupExpired(options.now);
        this.logger.log(
          `cleanup-restored: removed ${res.removedWindows} window(s), ${res.removedRows} row(s)`,
        );
        await this.finishRun(runId, 'succeeded', { rowCount: res.removedRows });
        return [];
      } catch (err) {
        const message = errorMessage(err);
        this.logger.error(`cleanup-restored failed: ${message}`);
        await this.finishRun(runId, 'failed', { error: message });
        return [`cleanup-restored: ${message}`];
      }
    });
  }

  /**
   * รัน fn ภายใต้ advisory lock ของงานนั้น — lock ผูกกับ connection จึงใช้ pg Client แยก
   * (ไม่ยืมจาก PG_POOL ที่ max 2 ซึ่ง exportMonth ใช้เต็มอยู่แล้ว)
   */
  async withLock(
    job: ArchiveJobName,
    dryRun: boolean,
    fn: () => Promise<string[]>,
    /** ชื่อล็อก (default = ชื่องาน) — backfill ใช้ล็อกเดียวกับ export-and-drop เพื่อไม่ให้ซ้อนกับ CronJob */
    lockAs: ArchiveJobName = job,
  ): Promise<JobOutcome> {
    const lock = this.createLockClient();
    await lock.connect();
    try {
      const res = await lock.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [`archive-job:${lockAs}`],
      );
      if (!res.rows[0]?.locked) {
        this.logger.warn(`${job}: another instance holds the lock — skipping`);
        if (!dryRun) {
          const id = await this.startRun(job, null, null);
          await this.finishRun(id, 'skipped', { error: 'advisory lock held by another instance' });
        }
        return { ok: true, skipped: true, failures: [] };
      }

      try {
        const failures = await fn();
        return { ok: failures.length === 0, skipped: false, failures };
      } finally {
        await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [`archive-job:${lockAs}`]);
      }
    } finally {
      await lock.end();
    }
  }

  async startRun(
    job: ArchiveJobName,
    table: ArchiveTable | null,
    month: MonthString | null,
  ): Promise<string> {
    const row = await this.prisma.archiveJobRun.create({
      data: {
        job,
        sourceTable: table,
        month: month ? monthRange(month).from : null,
      },
      select: { id: true },
    });
    return row.id;
  }

  async finishRun(
    id: string,
    status: 'succeeded' | 'failed' | 'skipped',
    result: { rowCount?: number; sha256?: string; error?: string } = {},
  ): Promise<void> {
    await this.prisma.archiveJobRun.update({
      where: { id },
      data: {
        status,
        rowCount: result.rowCount === undefined ? undefined : BigInt(result.rowCount),
        sha256: result.sha256,
        error: result.error,
        finishedAt: new Date(),
      },
    });
  }

  protected createLockClient(): Client {
    return new Client({ connectionString: this.config.get('databaseUrl', { infer: true }) });
  }
}

const errorMessage = describeError;
