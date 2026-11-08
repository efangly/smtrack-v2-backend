import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from './object-storage.service';
import { PG_POOL } from './backup.tokens';
import { describeError } from './describe-error';
import { ArchiveMeta } from './archive-export.service';
import {
  LEGACY_LOG_DAY_ARCHIVE_COLUMNS,
  LOG_DAYS_COLUMNS,
  unknownLogDayColumns,
} from './archive-tables';
import {
  archiveObjectKey,
  hotWindowStart,
  metaObjectKey,
  monthRange,
  monthsBetween,
  MonthString,
  startOfMonthUtc,
} from './archive.util';
import { RestoreInProgressException } from '../common/exceptions/restore-in-progress.exception';

const SOURCE_TABLE = 'log_days';
const TTL_MS = 24 * 60 * 60 * 1000; // ไม่มีใครอ่านเกิน 24 ชม. → ลบ (sliding: ทุกการอ่านต่ออายุ)
/** รอ restore ให้เสร็จได้นานสุดเท่านี้ ไม่งั้นตอบ 202 + Retry-After */
export const RESTORE_WAIT_BUDGET_MS = 10_000;
const POLL_MS = 250;
const RETRY_AFTER_SECONDS = 5;
const MAX_MONTHS_PER_REQUEST = 6;
/** restore พร้อมกันได้ต่อ pod — PG_POOL มีแค่ 2 connection */
const MAX_CONCURRENT_RESTORES = 2;
/** แถว pending/running ที่ไม่ขยับเกินนี้ถือว่า pod เจ้าของตายไปแล้ว ให้ตัวอื่นเข้ารับช่วงได้ */
const STALE_MS = 10 * 60 * 1000;
/** restore ที่เพิ่งล้มเหลวไม่ถูกลองซ้ำทันทีทุก request (กัน storage ล่มแล้วถูกรุม) */
const FAILED_COOLDOWN_MS = 30 * 1000;
/** cleanup เก็บกวาดแถวที่ค้างสถานะอื่นที่ไม่ใช่ done นานเกินนี้ */
const STUCK_MS = 60 * 60 * 1000;

export interface CleanupResult {
  removedWindows: number;
  removedRows: number;
}

/**
 * On-demand restore: นำข้อมูล log_days ของ "จุดติดตั้งหนึ่ง × เดือนหนึ่ง" จาก archive กลับเข้า
 * log_day_archive ชั่วคราวเมื่อคำขอย้อนหลังเกิน hot window (ดู CONTEXT.md: Restored window)
 *
 * - แถวใน restored_window เป็นทั้งล็อกข้าม replica (unique key) และตัวนับ TTL
 * - รันใน process ของ API เอง (ไม่แยก worker) จำกัดพร้อมกันต่อ pod ด้วย MAX_CONCURRENT_RESTORES
 */
@Injectable()
export class RestoredWindowService {
  private readonly logger = new Logger(RestoredWindowService.name);
  private active = 0;

  constructor(
    private readonly storage: ObjectStorageService,
    private readonly prisma: PrismaService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /**
   * ให้แน่ใจว่าข้อมูลของ device ในช่วง [from, to] ที่อยู่นอก hot window อ่านได้จาก log_day_archive แล้ว
   * คืนเมื่อพร้อม หรือ throw RestoreInProgressException (202) ถ้าไม่เสร็จภายใน RESTORE_WAIT_BUDGET_MS
   *
   * ผู้เรียกต้องตรวจสิทธิ์ของ deviceId (access scope) มาก่อนแล้ว — ที่นี่ไม่ตรวจซ้ำ
   */
  async ensureRange(deviceId: string, from: Date, to: Date, now: Date = new Date()): Promise<void> {
    const boundary = hotWindowStart(now);
    if (from >= boundary) return;
    const outsideEnd = to < boundary ? to : boundary;
    if (outsideEnd <= from) return;

    const firstMonth = startOfMonthUtc(from);
    const lastMonth = startOfMonthUtc(new Date(outsideEnd.getTime() - 1));
    const months = monthsBetween(
      firstMonth,
      new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 1)),
    );
    if (months.length > MAX_MONTHS_PER_REQUEST) {
      throw new BadRequestException(
        `ช่วงเวลาที่ขอข้อมูลย้อนหลังจาก archive ได้ไม่เกิน ${MAX_MONTHS_PER_REQUEST} เดือนต่อคำขอ`,
      );
    }

    // เดือนที่ไม่มี archive (ยังอยู่ใน log_days หรือไม่เคยมีข้อมูล) ไม่มีอะไรให้ restore
    const archived = await this.prisma.archiveExport.findMany({
      where: { sourceTable: SOURCE_TABLE, month: { in: months.map((m) => monthRange(m).from) } },
      select: { month: true },
    });
    const archivedSet = new Set(archived.map((a) => a.month.toISOString().slice(0, 7)));
    const targets = months.filter((m) => archivedSet.has(m));
    if (targets.length === 0) return;

    const deadline = Date.now() + RESTORE_WAIT_BUDGET_MS;
    const work = Promise.all(targets.map((m) => this.acquire(deviceId, m, deadline)));
    work.catch(() => undefined); // ถ้า race แพ้ timeout ห้ามกลายเป็น unhandled rejection
    await this.withTimeout(work, RESTORE_WAIT_BUDGET_MS);
  }

  /**
   * ลบข้อมูลที่ restore ไว้ซึ่งหมดอายุ (ไม่มีใครอ่านเกิน TTL) และเก็บกวาดแถวที่ค้างสถานะ
   * ล็อกแถวด้วย FOR UPDATE และตรวจเงื่อนไขซ้ำในทรานแซกชัน — ถ้ามี request ต่ออายุตัดหน้า
   * แถวนั้นจะไม่ถูกลบ (ส่วน request ที่มาทีหลังจะเห็นว่าไม่มีแถวแล้วและ restore ใหม่)
   */
  async cleanupExpired(now: Date = new Date()): Promise<CleanupResult> {
    const stuckBefore = new Date(now.getTime() - STUCK_MS);
    const candidates = await this.prisma.restoredWindow.findMany({
      where: {
        OR: [
          { status: 'done', expiresAt: { lt: now } },
          { status: { in: ['failed', 'pending', 'running'] }, requestedAt: { lt: stuckBefore } },
        ],
      },
      select: { id: true },
      take: 500,
    });

    const result: CleanupResult = { removedWindows: 0, removedRows: 0 };
    for (const { id } of candidates) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query<{ device_id: string; month: string }>(
          `SELECT "device_id", to_char("month", 'YYYY-MM-DD') AS month
           FROM "restored_window"
           WHERE "id" = $1
             AND (("status" = 'done' AND "expires_at" < $2::timestamp)
               OR ("status" <> 'done' AND "requested_at" < $3::timestamp))
           FOR UPDATE`,
          [id, now.toISOString(), stuckBefore.toISOString()],
        );
        if (locked.rowCount === 0) {
          await client.query('ROLLBACK');
          continue;
        }
        const { device_id, month } = locked.rows[0];
        const del = await client.query(
          `DELETE FROM "log_day_archive"
           WHERE "device_id" = $1 AND "send_time" >= $2::date
             AND "send_time" < ($2::date + INTERVAL '1 month')`,
          [device_id, month],
        );
        await client.query('DELETE FROM "restored_window" WHERE "id" = $1', [id]);
        await client.query('COMMIT');
        result.removedWindows += 1;
        result.removedRows += del.rowCount ?? 0;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------------------------

  /** คืนเมื่อ (device, month) นี้พร้อมอ่านแล้ว — ไม่ว่าเราเป็นคน restore เองหรือรอตัวอื่นทำ */
  private async acquire(deviceId: string, month: MonthString, deadline: number): Promise<void> {
    const monthDate = monthRange(month).from;
    const where = {
      sourceTable_deviceId_month: { sourceTable: SOURCE_TABLE, deviceId, month: monthDate },
    };

    for (;;) {
      const row = await this.prisma.restoredWindow.findUnique({ where });
      const now = Date.now();

      if (!row) {
        // ผู้เรียกหมดเวลารอไปแล้ว (ได้ 202) — ห้ามเริ่ม restore ใหม่ในนามคำขอที่จบไปแล้ว
        // (งานที่เริ่มไปแล้วใน runRestore ไม่ถูกตัดตรงนี้ และจะเสร็จเองเพื่อให้การลองใหม่ได้ข้อมูลทันที)
        if (now >= deadline) throw new RestoreInProgressException(RETRY_AFTER_SECONDS);
        if (!(await this.waitForSlot(deadline)))
          throw new RestoreInProgressException(RETRY_AFTER_SECONDS);
        try {
          const created = await this.prisma.restoredWindow.create({
            data: {
              sourceTable: SOURCE_TABLE,
              deviceId,
              month: monthDate,
              expiresAt: new Date(now + TTL_MS),
            },
            select: { id: true },
          });
          return await this.runRestore(created.id, deviceId, month);
        } catch (err) {
          if (isUniqueViolation(err)) continue; // มีคนตัดหน้าสร้างก่อน → วนไปรอเขา
          throw err;
        }
      }

      if (row.status === 'done') {
        // ต่ออายุ (sliding) — ถ้า cleanup ลบแถวไปตัดหน้า count จะเป็น 0 แล้ววนไป restore ใหม่
        const touched = await this.prisma.restoredWindow.updateMany({
          where: { id: row.id, status: 'done' },
          data: { lastReadAt: new Date(now), expiresAt: new Date(now + TTL_MS) },
        });
        if (touched.count === 1) return;
        continue;
      }

      const age = now - row.requestedAt.getTime();
      if (row.status === 'failed' && age < FAILED_COOLDOWN_MS) {
        throw new ServiceUnavailableException(
          `นำข้อมูลเดือน ${month} กลับจาก archive ไม่สำเร็จ: ${row.error ?? 'unknown error'}`,
        );
      }
      if (row.status === 'failed' || age > STALE_MS) {
        if (now >= deadline) throw new RestoreInProgressException(RETRY_AFTER_SECONDS);
        if (!(await this.waitForSlot(deadline)))
          throw new RestoreInProgressException(RETRY_AFTER_SECONDS);
        // claim แบบ compare-and-set — มีผู้ชนะคนเดียว
        const claimed = await this.prisma.restoredWindow.updateMany({
          where: { id: row.id, status: row.status, requestedAt: row.requestedAt },
          data: { status: 'pending', requestedAt: new Date(now), error: null },
        });
        if (claimed.count === 1) return this.runRestore(row.id, deviceId, month);
        continue;
      }

      // pending/running โดยตัวอื่น (หรือ pod อื่น) → รอ
      if (now >= deadline) throw new RestoreInProgressException(RETRY_AFTER_SECONDS);
      await this.sleep(POLL_MS);
    }
  }

  private async runRestore(id: string, deviceId: string, month: MonthString): Promise<void> {
    this.active += 1;
    try {
      await this.prisma.restoredWindow.update({ where: { id }, data: { status: 'running' } });
      const rowCount = await this.restoreFromArchive(deviceId, month);
      const now = new Date();
      await this.prisma.restoredWindow.update({
        where: { id },
        data: {
          status: 'done',
          rowCount: BigInt(rowCount),
          restoredAt: now,
          lastReadAt: now,
          expiresAt: new Date(now.getTime() + TTL_MS),
          error: null,
        },
      });
      this.logger.log(`restored log_days ${month} for device ${deviceId}: ${rowCount} rows`);
    } catch (err) {
      const message = describeError(err);
      this.logger.error(`restore log_days ${month} for device ${deviceId} failed: ${message}`);
      await this.prisma.restoredWindow
        .update({ where: { id }, data: { status: 'failed', error: message.slice(0, 500) } })
        .catch(() => undefined);
      throw err;
    } finally {
      this.active -= 1;
    }
  }

  /**
   * COPY ทั้งไฟล์เดือนเข้า temp table แล้วคัดเฉพาะแถวของ device นี้เข้า log_day_archive
   * (gzip อ่านข้ามช่วงไม่ได้ — ต้องไล่ทั้งไฟล์ ~30 MB ต่อเดือนที่สเกลปัจจุบัน)
   *
   * กรองแถวที่มีอยู่แล้วทั้งใน log_days และ log_day_archive ออก: chunk ที่คาบเกี่ยวขอบเดือนยังเหลือ
   * ส่วนท้ายของเดือนเก่าใน log_days ถ้าไม่กรอง view log_days_all จะซ้ำ
   */
  private async restoreFromArchive(deviceId: string, month: MonthString): Promise<number> {
    const key = archiveObjectKey(month, SOURCE_TABLE);
    if (!(await this.storage.exists(key))) {
      throw new NotFoundException(`ไม่พบ backup ของเดือน ${month} (${key})`);
    }
    const metaKey = metaObjectKey(month, SOURCE_TABLE);
    const meta = (await this.storage.exists(metaKey))
      ? await this.storage.getJson<ArchiveMeta>(metaKey)
      : undefined;
    const fileColumns = meta?.columns ?? LEGACY_LOG_DAY_ARCHIVE_COLUMNS;
    const unknown = unknownLogDayColumns(fileColumns);
    if (unknown.length > 0) {
      throw new BadRequestException(`ไฟล์ meta ระบุคอลัมน์ที่ไม่รู้จัก: ${unknown.join(', ')}`);
    }

    // ไฟล์ก่อนมีคอลัมน์ device_id: ผูกแถวกับจุดติดตั้งผ่านประวัติการติดตั้งกล่อง (device_assignments)
    // ตามช่วงเวลา เพราะกล่องเดียวย้ายไปอยู่หลายจุดติดตั้งได้ — แถวที่เก่ากว่าการติดตั้งครั้งแรกที่บันทึกไว้
    // ถือเป็นของจุดแรก (เหมือนที่ migration แยก Devices/Hardware ประทับ device_id ให้ log เก่า)
    // แถวที่ตกในช่วงที่กล่องไม่ได้ติดตั้งที่ไหน (ended_at แล้วยังไม่ติดตั้งใหม่) จะไม่ถูกผูกกับจุดใด
    const hasDeviceId = fileColumns.includes('device_id');
    const insertCols = LOG_DAYS_COLUMNS.map((c) => `"${c}"`).join(', ');
    const selectCols = LOG_DAYS_COLUMNS.map((c) =>
      c === 'device_id' && !hasDeviceId ? 'm."device_id"' : `t."${c}"`,
    ).join(', ');
    const source = hasDeviceId
      ? `FROM "_restore_tmp" t WHERE t."device_id" = $1`
      : `FROM "_restore_tmp" t
         JOIN LATERAL (
           SELECT a."device_id" FROM "device_assignments" a
           WHERE a."serial" = t."serial"
             AND (a."started_at" <= t."send_time"
                  OR a."started_at" = (SELECT min(f."started_at") FROM "device_assignments" f WHERE f."serial" = t."serial"))
             AND (a."ended_at" IS NULL OR t."send_time" < a."ended_at")
           ORDER BY a."started_at" DESC
           LIMIT 1
         ) m ON m."device_id" = $1
         WHERE TRUE`;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'CREATE TEMP TABLE "_restore_tmp" (LIKE "log_day_archive" INCLUDING DEFAULTS) ON COMMIT DROP',
      );
      const ingest = client.query(
        copyFrom(
          `COPY "_restore_tmp" (${fileColumns.map((c) => `"${c}"`).join(', ')}) FROM STDIN WITH (FORMAT csv, HEADER)`,
        ),
      );
      await pipeline(await this.storage.getStream(key), createGunzip(), ingest);

      const inserted = await client.query(
        `INSERT INTO "log_day_archive" (${insertCols})
         SELECT ${selectCols}
         ${source}
           AND NOT EXISTS (SELECT 1 FROM "log_days" l WHERE l."id" = t."id" AND l."send_time" = t."send_time")
           AND NOT EXISTS (SELECT 1 FROM "log_day_archive" x WHERE x."id" = t."id" AND x."send_time" = t."send_time")`,
        [deviceId],
      );
      await client.query('COMMIT');
      return inserted.rowCount ?? 0;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** รอจนมี slot ว่าง (true) หรือหมดเวลา (false) */
  private async waitForSlot(deadline: number): Promise<boolean> {
    while (this.active >= MAX_CONCURRENT_RESTORES) {
      if (Date.now() >= deadline) return false;
      await this.sleep(POLL_MS);
    }
    return true;
  }

  private async withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RestoreInProgressException(RETRY_AFTER_SECONDS)), ms);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
