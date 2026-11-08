import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import { createGunzip, createGzip } from 'node:zlib';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ObjectStorageService } from './object-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { PG_POOL } from './backup.tokens';
import { CsvStats } from './csv-stats';
import {
  ARCHIVE_TABLE_SPECS,
  ArchiveTable,
  LEGACY_LOG_DAY_ARCHIVE_COLUMNS,
  LOG_DAYS_COLUMNS,
} from './archive-tables';
import {
  archiveObjectKey,
  hotWindowStart,
  isMonthString,
  metaObjectKey,
  monthRange,
  monthsBetween,
  MonthString,
  startOfMonthUtc,
} from './archive.util';

// ย้ายไป archive-tables.ts แล้ว — re-export ไว้ให้ของเดิมที่ import จากไฟล์นี้ยังใช้ได้
export { LOG_DAYS_COLUMNS };

export interface ArchiveMeta {
  month: MonthString;
  /** ตารางต้นทาง — ไม่มีในไฟล์ที่ export ก่อนรองรับหลายตาราง (ทั้งหมดคือ log_days) */
  table?: ArchiveTable;
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

export interface DropResult {
  table: ArchiveTable;
  /** ลบทุก chunk ที่จบก่อนเวลานี้ */
  cutoff: Date;
  droppedChunks: number;
}

/**
 * export ข้อมูลรายเดือนของ 4 ตารางขึ้น object storage และลบ chunk ที่ออกจาก hot window แล้ว
 *
 * ไม่มีตัวตั้งเวลาในคลาสนี้อีกแล้ว — ถูกเรียกจาก CLI ที่รันเป็น k8s CronJob (ADR-0006)
 * และ chunk จะถูกลบก็ต่อเมื่อเดือนนั้นมี ArchiveExport ที่ตรวจผ่านแล้วเท่านั้น (ADR-0005)
 */
@Injectable()
export class ArchiveExportService {
  private readonly logger = new Logger(ArchiveExportService.name);

  constructor(
    private readonly storage: ObjectStorageService,
    private readonly prisma: PrismaService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /**
   * export เดือนที่ระบุ (เรียกซ้ำได้ ปลอดภัย)
   *
   * ไฟล์ใหม่ถูกเขียนที่ key ชั่วคราว (`.staging`) ตรวจจำนวนแถวให้ผ่านก่อน แล้วค่อย copy ทับ key จริง
   * — การตรวจล้มเหลวหรืออัปโหลดขาดกลางทางจึงไม่แตะ archive เดิมที่ครบอยู่
   *
   * ถ้าเดือนนั้นเคย archive แล้วแต่ใน DB เหลือแถวน้อยกว่า (chunk ถูก drop ไปบางส่วน) จะ "ผสาน" ไฟล์เดิมกับ
   * แถวที่เหลือใน DB (เช่นข้อมูลที่มาถึงช้า) แทนการ export ทับ ซึ่งจะได้ไฟล์ไม่ครบ
   */
  async exportMonth(month: MonthString, table: ArchiveTable = 'log_days'): Promise<ArchiveMeta> {
    if (!isMonthString(month)) {
      throw new Error(`รูปแบบเดือนไม่ถูกต้อง: "${month}" (ต้องเป็น YYYY-MM)`);
    }
    const spec = ARCHIVE_TABLE_SPECS[table];
    if (!spec) throw new Error(`ไม่รู้จักตาราง archive: "${table}"`);

    const { from, to } = monthRange(month);
    const key = archiveObjectKey(month, table);
    const stagingKey = `${key}.staging`;

    const existing = await this.prisma.archiveExport.findUnique({
      where: { sourceTable_month: { sourceTable: table, month: from } },
      select: { rowCount: true },
    });
    const merge = existing
      ? (await this.countRows(table, from, to)) < Number(existing.rowCount)
      : false;

    // เวลาที่ใช้เทียบหา "ข้อมูลมาช้า" ภายหลัง ต้องจับก่อนเริ่ม COPY — แถวที่ commit ระหว่าง COPY
    // อาจไม่อยู่ใน snapshot แต่มี create_at ก่อนเวลาสิ้นสุด export ถ้าจับตอนท้ายจะหลุดการตรวจ
    const startedAt = new Date();
    this.logger.log(
      `${merge ? 'merging' : 'exporting'} ${table} ${month} -> s3://${this.storage.bucket}/${key}`,
    );

    const colList = spec.columns.map((c) => `"${c}"`).join(', ');
    const range = `"${spec.timeColumn}" >= '${from.toISOString()}' AND "${spec.timeColumn}" < '${to.toISOString()}'`;

    const client = await this.pool.connect();
    try {
      let selectSql = `SELECT ${colList} FROM "${spec.name}" WHERE ${range} ORDER BY ${spec.orderBy}`;
      let expected: number | null = null;

      if (merge) {
        // snapshot เดียวตลอดทั้งการนับและการ COPY OUT — ไม่งั้นแถวที่เข้ามาระหว่างทางทำให้นับไม่ตรง
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query(
          `CREATE TEMP TABLE "_merge_tmp" (LIKE "${spec.name}" INCLUDING DEFAULTS) ON COMMIT DROP`,
        );
        const fileColumns = await this.existingFileColumns(month, table);
        const ingest = client.query(
          copyFrom(
            `COPY "_merge_tmp" (${fileColumns.map((c) => `"${c}"`).join(', ')}) FROM STDIN WITH (FORMAT csv, HEADER)`,
          ),
        );
        await pipeline(await this.storage.getStream(key), createGunzip(), ingest);

        // แถวเดียวกัน (id เดียวกัน) ใน DB ชนะไฟล์เดิม เพราะเป็นค่าที่ใหม่กว่า
        const merged = `SELECT DISTINCT ON ("id") ${colList} FROM (
            SELECT 1 AS "_pri", ${colList} FROM "${spec.name}" WHERE ${range}
            UNION ALL
            SELECT 2 AS "_pri", ${colList} FROM "_merge_tmp" WHERE ${range}
          ) u ORDER BY "id", "_pri"`;
        const counted = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM (${merged}) m`,
        );
        expected = Number(counted.rows[0]?.count ?? 0);
        selectSql = `SELECT ${colList} FROM (${merged}) m ORDER BY ${spec.orderBy}`;
      }

      const stats = new CsvStats();
      const body = new PassThrough();
      const uploadDone = this.storage.uploadStream(stagingKey, body, 'application/gzip');
      // อัปโหลดอาจล้มระหว่างที่ pipeline ยังรันอยู่ — ต้องมี handler ตั้งแต่ต้น ไม่งั้นเป็น unhandled rejection
      uploadDone.catch(() => undefined);
      try {
        await pipeline(
          client.query(copyTo(`COPY (${selectSql}) TO STDOUT WITH (FORMAT csv, HEADER)`)),
          stats,
          createGzip({ level: 6 }),
          body,
        );
        await uploadDone;
      } catch (err) {
        await uploadDone.catch(() => undefined);
        throw err;
      }
      if (merge) await client.query('COMMIT');

      const rowCount = stats.rowCount;
      const dbCount = expected ?? (await this.countRows(table, from, to));
      if (dbCount !== rowCount) {
        await this.storage.delete(stagingKey); // archive เดิมยังอยู่ครบ ลบเฉพาะไฟล์ชั่วคราว
        throw new Error(
          `row count mismatch for ${table} ${month}: db=${dbCount}, file=${rowCount}`,
        );
      }
      if (existing && rowCount < Number(existing.rowCount)) {
        await this.storage.delete(stagingKey);
        throw new Error(
          `refusing to replace ${table} ${month}: new archive has ${rowCount} rows, existing has ${existing.rowCount}`,
        );
      }

      const meta: ArchiveMeta = {
        month,
        table,
        rowCount,
        sha256: stats.hash.digest('hex'),
        exportedAt: new Date().toISOString(),
        columns: spec.columns,
      };
      // meta ก่อน แล้วค่อย promote ข้อมูล: ถ้าล้มระหว่างทาง รอบถัดไปจะเห็นเดือนนี้ยังค้าง (ไม่มี
      // ArchiveExport ใหม่) แล้วทำซ้ำ — ลำดับนี้ไม่เคยทิ้งสถานะที่ "ดูสำเร็จ" ทั้งที่ไฟล์ไม่ครบ
      await this.storage.putJson(metaObjectKey(month, table), meta);
      await this.storage.copy(stagingKey, key);
      await this.storage.delete(stagingKey);

      await this.prisma.archiveExport.upsert({
        where: { sourceTable_month: { sourceTable: table, month: from } },
        create: {
          sourceTable: table,
          month: from,
          rowCount: BigInt(rowCount),
          objectKey: key,
          sha256: meta.sha256,
          exportedAt: startedAt,
        },
        update: {
          rowCount: BigInt(rowCount),
          objectKey: key,
          sha256: meta.sha256,
          exportedAt: startedAt,
        },
      });

      this.logger.log(
        `${merge ? 'merged' : 'exported'} ${table} ${month}: ${rowCount} rows, sha256=${meta.sha256.slice(0, 12)}…`,
      );
      return meta;
    } catch (err) {
      if (merge) await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** ลำดับคอลัมน์ของไฟล์ที่ archive ไว้ — ไฟล์ log_days รุ่นเก่าไม่มี meta.columns จึงใช้ชุด legacy */
  private async existingFileColumns(month: MonthString, table: ArchiveTable): Promise<string[]> {
    const metaKey = metaObjectKey(month, table);
    const meta = (await this.storage.exists(metaKey))
      ? await this.storage.getJson<ArchiveMeta>(metaKey)
      : undefined;
    const columns = meta?.columns ?? (table === 'log_days' ? LEGACY_LOG_DAY_ARCHIVE_COLUMNS : null);
    if (!columns) throw new Error(`ไม่พบ meta.columns ของ ${table} ${month} — ผสานไฟล์ไม่ได้`);
    const known = new Set<string>(ARCHIVE_TABLE_SPECS[table].columns);
    const unknown = columns.filter((c) => !known.has(c));
    if (unknown.length > 0) {
      throw new Error(`meta ของ ${table} ${month} ระบุคอลัมน์ที่ไม่รู้จัก: ${unknown.join(', ')}`);
    }
    return [...columns];
  }

  /**
   * เดือนที่ "จบแล้ว" (ก่อนเดือนปัจจุบัน) ซึ่งยังมีข้อมูลใน DB และยังไม่มี archive ที่ใช้ได้ เรียงเก่า→ใหม่
   *
   * ไม่คำนวณเดือนเดียวจากสูตรวันที่ — ถ้า CronJob พลาดไปรอบหนึ่ง รอบถัดไปจะซ่อมให้เอง
   * archive ที่ "ใช้ไม่ได้" คือ ไม่เคย export, หรือ มีแถวของเดือนนั้นถูกเขียนลง DB หลังเวลา export
   * (ข้อมูลที่มาถึงช้า เช่นอุปกรณ์ offline ส่งย้อนหลัง — ถ้าไม่ export ซ้ำจะหายตอน drop)
   *
   * ไม่เทียบจำนวนแถว: หลัง drop chunk ที่คาบเกี่ยวขอบเดือนจะเหลือแค่ส่วนท้ายของเดือน จำนวนจึงน้อยกว่า
   * ที่ export ไว้เสมอ ถ้านับเทียบจะตีความว่าค้างแล้ว export ทับด้วยไฟล์ไม่ครบ
   */
  async findPendingMonths(table: ArchiveTable, now: Date = new Date()): Promise<MonthString[]> {
    const spec = ARCHIVE_TABLE_SPECS[table];
    const first = await this.pool.query<{ first: Date | null }>(
      // คอลัมน์เป็น timestamp without time zone ที่เก็บเวลา UTC — ถ้าอ่านตรง ๆ node-pg จะตีความเป็นเวลา
      // ท้องถิ่นของเครื่อง (เครื่อง +07:00 ได้เดือนก่อนหน้าเมื่อเป็นวันที่ 1) AT TIME ZONE 'UTC' บังคับให้ถูก
      `SELECT min("${spec.timeColumn}") AT TIME ZONE 'UTC' AS first FROM "${spec.name}"`,
    );
    const firstRow = first.rows[0]?.first;
    if (!firstRow) return [];

    const firstMonth = startOfMonthUtc(new Date(firstRow));
    const currentMonth = startOfMonthUtc(now);
    const months = monthsBetween(firstMonth, currentMonth);
    if (months.length === 0) return [];

    const exported = await this.prisma.archiveExport.findMany({
      where: { sourceTable: table, month: { gte: firstMonth, lt: currentMonth } },
      select: { month: true, exportedAt: true },
    });
    const exportedAt = new Map(
      exported.map((e) => [e.month.toISOString().slice(0, 7), e.exportedAt]),
    );

    const pending: MonthString[] = [];
    for (const month of months) {
      const at = exportedAt.get(month);
      if (at === undefined) {
        pending.push(month);
        continue;
      }
      const { from, to } = monthRange(month);
      if ((await this.countLateRows(table, from, to, at)) > 0) pending.push(month);
    }
    return pending;
  }

  /**
   * ลบ chunk ที่ออกจาก hot window แล้ว "และ" ทุกเดือนก่อนหน้าจุดนั้นมี archive ที่ใช้ได้
   *
   * cutoff = เล็กกว่าของ (ต้น hot window, ต้นเดือนที่เก่าที่สุดที่ยัง pending)
   * drop_chunks ลบเฉพาะ chunk ที่ "จบก่อน" cutoff ทั้งก้อน — และทุกแถวก่อน cutoff อยู่ในเดือนที่
   * archive ผ่านแล้ว จึงไม่ต้องสนใจว่าขอบ chunk (นับจาก epoch) ไม่ตรงกับขอบเดือนปฏิทิน
   */
  async dropVerifiedChunks(table: ArchiveTable, now: Date = new Date()): Promise<DropResult> {
    const spec = ARCHIVE_TABLE_SPECS[table];
    const { cutoff, pending } = await this.planDrop(table, now);

    const res = await this.pool.query(
      `SELECT drop_chunks('"${spec.name}"'::regclass, older_than => $1::timestamp)`,
      [cutoff.toISOString()],
    );
    const droppedChunks = res.rowCount ?? 0;
    this.logger.log(
      `dropped ${droppedChunks} chunk(s) of ${table} older than ${cutoff.toISOString()}` +
        (pending.length > 0 ? ` (${pending.length} month(s) still pending archive)` : ''),
    );
    return { table, cutoff, droppedChunks };
  }

  /** คำนวณว่าจะลบถึงเมื่อไร โดยไม่ลบจริง (ใช้กับ --dry-run) */
  async planDrop(
    table: ArchiveTable,
    now: Date = new Date(),
  ): Promise<{ cutoff: Date; pending: MonthString[] }> {
    const pending = await this.findPendingMonths(table, now);
    let cutoff = hotWindowStart(now);
    if (pending.length > 0) {
      const oldestPending = monthRange(pending[0]).from;
      if (oldestPending < cutoff) cutoff = oldestPending;
    }
    return { cutoff, pending };
  }

  /** แถวของช่วงเวลานั้นที่ถูกเขียนลง DB (create_at) หลัง `since` */
  private async countLateRows(
    table: ArchiveTable,
    from: Date,
    to: Date,
    since: Date,
  ): Promise<number> {
    const spec = ARCHIVE_TABLE_SPECS[table];
    const res = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${spec.name}"
       WHERE "${spec.timeColumn}" >= $1::timestamp AND "${spec.timeColumn}" < $2::timestamp
         AND "create_at" > $3::timestamp`,
      [from.toISOString(), to.toISOString(), since.toISOString()],
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  /** จำนวนแถวของเดือนนั้นที่ยังอยู่ในฐานข้อมูล (ใช้ประเมินงานใน dry-run) */
  countMonth(table: ArchiveTable, month: MonthString): Promise<number> {
    const { from, to } = monthRange(month);
    return this.countRows(table, from, to);
  }

  private async countRows(table: ArchiveTable, from: Date, to: Date): Promise<number> {
    const spec = ARCHIVE_TABLE_SPECS[table];
    const res = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${spec.name}"
       WHERE "${spec.timeColumn}" >= $1::timestamp AND "${spec.timeColumn}" < $2::timestamp`,
      [from.toISOString(), to.toISOString()],
    );
    return Number(res.rows[0]?.count ?? 0);
  }
}
