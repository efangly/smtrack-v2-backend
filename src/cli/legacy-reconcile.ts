/**
 * Legacy sync — reconciliation รายวัน (ADR-0007, docs/legacy-sync-contract.md §6)
 *
 *   node dist/cli/legacy-reconcile [--days=1]
 *
 * อ่าน DB ของระบบเดิมแบบ read-only เพื่อ "ตรวจ" เท่านั้น ไม่เขียนอะไรลง v2:
 * 1. จำนวน log ราย serial ต่อวัน (UTC) ย้อนหลัง N วันที่จบแล้ว — ไม่นับวันนี้ที่ยังรับข้อมูลอยู่
 * 2. ต่อ entity metadata: จำนวนแถวในระบบเดิม เทียบกับแถวที่ sync แล้ว และ updateAt ล่าสุดที่ apply แล้ว
 *
 * env: SOURCE_DATABASE_URL (smtrack-device), SOURCE_LOG_DATABASE_URL (smtrack-log ถ้าแยก DB;
 * default = SOURCE_DATABASE_URL), DATABASE_URL (v2)
 * exit code: 0 = ตรงกันทั้งหมด, 1 = พบ mismatch (CronJob เป็น Failed → alert), 2 = ใช้ผิด
 */
import 'dotenv/config';
import { Pool } from 'pg';

const METADATA: { entity: string; table: string; pk: string }[] = [
  { entity: 'device', table: 'Devices', pk: 'deviceId' },
  { entity: 'probe', table: 'Probes', pk: 'id' },
  { entity: 'config', table: 'Configs', pk: 'id' },
  { entity: 'repair', table: 'Repairs', pk: 'id' },
  { entity: 'warranty', table: 'Warranties', pk: 'id' },
];

export interface DailyCount {
  serial: string;
  day: string;
  count: number;
}

export interface LogMismatch {
  serial: string;
  day: string;
  legacy: number;
  v2: number;
}

/** v2 มีมากกว่าได้ (กล่องส่งเข้า v2 ตรงหลังย้าย) — mismatch คือ v2 มีน้อยกว่าระบบเดิมเท่านั้น */
export function diffDailyCounts(legacy: DailyCount[], v2: DailyCount[]): LogMismatch[] {
  const key = (c: { serial: string; day: string }) => `${c.serial}|${c.day}`;
  const v2Counts = new Map(v2.map((c) => [key(c), c.count]));
  return legacy
    .map((c) => ({ serial: c.serial, day: c.day, legacy: c.count, v2: v2Counts.get(key(c)) ?? 0 }))
    .filter((m) => m.v2 < m.legacy);
}

export function parseDays(argv: string[]): number | { error: string } {
  const flag = argv.find((a) => a.startsWith('--days='));
  if (!flag) return 1;
  const days = Number(flag.slice('--days='.length));
  if (!Number.isInteger(days) || days < 1 || days > 31) return { error: '--days must be 1..31' };
  return days;
}

async function dailyCounts(
  pool: Pool,
  table: string,
  serialCol: string,
  timeCol: string,
  days: number,
): Promise<DailyCount[]> {
  const { rows } = await pool.query<{ serial: string; day: string; count: string }>(
    `SELECT ${serialCol} AS serial, to_char(date_trunc('day', ${timeCol} AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            count(*) AS count
       FROM ${table}
      WHERE ${timeCol} >= date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => $1)
        AND ${timeCol} <  date_trunc('day', now() AT TIME ZONE 'UTC')
      GROUP BY 1, 2`,
    [days],
  );
  return rows.map((r) => ({ serial: r.serial, day: r.day, count: Number(r.count) }));
}

async function main(): Promise<number> {
  const days = parseDays(process.argv.slice(2));
  if (typeof days !== 'number') {
    console.error(days.error);
    return 2;
  }
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  if (!sourceUrl || !process.env.DATABASE_URL) {
    console.error('SOURCE_DATABASE_URL and DATABASE_URL are required');
    return 2;
  }

  const legacy = new Pool({ connectionString: sourceUrl });
  const legacyLog = new Pool({
    connectionString: process.env.SOURCE_LOG_DATABASE_URL || sourceUrl,
  });
  const v2 = new Pool({ connectionString: process.env.DATABASE_URL });
  let problems = 0;

  try {
    const logMismatches = diffDailyCounts(
      await dailyCounts(legacyLog, '"LogDays"', '"serial"', '"sendTime"', days),
      await dailyCounts(v2, 'log_days_all', 'serial', 'send_time', days),
    );
    for (const m of logMismatches) {
      console.error(`[log] ${m.serial} ${m.day}: legacy=${m.legacy} v2=${m.v2}`);
    }
    problems += logMismatches.length;
    console.log(`[log] ${days} day(s): ${logMismatches.length} serial-day mismatch(es)`);

    for (const { entity, table, pk } of METADATA) {
      const { rows: src } = await legacy.query<{ count: string; max: Date | null }>(
        `SELECT count(*) AS count, max("updateAt") AS max FROM "${table}"`,
      );
      // แถวในระบบเดิมที่ยังไม่เคยถูก apply (ไม่มีใน map) — ระบุ PK ให้ตามแก้ได้
      // นับแถว retired ด้วย: แถว device เก่าหลัง Swap ยังอยู่ในระบบเดิมได้ แต่ v2 จัดการแล้ว
      const { rows: ids } = await legacy.query<{ id: string }>(
        `SELECT "${pk}" AS id FROM "${table}"`,
      );
      const { rows: synced } = await v2.query<{ legacy_id: string }>(
        `SELECT legacy_id FROM legacy_sync_map WHERE entity = $1`,
        [entity],
      );
      const { rows: dst } = await v2.query<{ max: Date | null }>(
        `SELECT max(legacy_updated_at) AS max FROM legacy_sync_map WHERE entity = $1`,
        [entity],
      );
      const syncedIds = new Set(synced.map((r) => r.legacy_id));
      const missing = ids.filter((r) => !syncedIds.has(r.id)).map((r) => r.id);
      const srcMax = src[0].max?.getTime() ?? 0;
      const dstMax = dst[0].max?.getTime() ?? 0;
      const behind = srcMax > dstMax;

      if (missing.length) {
        console.error(
          `[${entity}] ${missing.length} row(s) not synced: ${missing.slice(0, 20).join(', ')}`,
        );
      }
      if (behind) {
        console.error(
          `[${entity}] behind: legacy max updateAt=${src[0].max?.toISOString()} v2=${dst[0].max?.toISOString() ?? '-'}`,
        );
      }
      problems += missing.length + (behind ? 1 : 0);
      console.log(
        `[${entity}] legacy=${src[0].count} synced=${syncedIds.size} missing=${missing.length}`,
      );
    }
  } finally {
    await Promise.all([legacy.end(), legacyLog.end(), v2.end()]);
  }

  console.log(
    problems === 0 ? 'reconciliation OK' : `reconciliation FAILED: ${problems} problem(s)`,
  );
  return problems === 0 ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
