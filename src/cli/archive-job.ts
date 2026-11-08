/**
 * Entrypoint ของ k8s CronJob สำหรับงาน archive (ADR-0006)
 *
 *   node dist/cli/archive-job export-and-drop [--dry-run] [--table=log_days,notifications]
 *   node dist/cli/archive-job cleanup-restored [--dry-run]
 *   node dist/cli/archive-job backfill [--dry-run] [--table=...] [--from=YYYY-MM] [--to=YYYY-MM]
 *   node dist/cli/archive-job verify [--table=...] [--from=YYYY-MM] [--to=YYYY-MM]
 *
 * backfill = archive ข้อมูลเก่าที่ค้างใน DB โดยไม่ลบอะไร (ขั้น 3 ของ cut-over), verify = ตรวจว่าพร้อมถอด
 * add_retention_policy (ขั้น 4) — ดู docs/archive-operations.md
 *
 * exit code: 0 = สำเร็จ (หรือข้ามเพราะมี instance อื่นรันอยู่), 1 = มีขั้นล้มเหลว, 2 = ใช้คำสั่งผิด
 * Job จึงเป็น Failed เมื่อ export/drop ล้มเหลว และ alert จับได้จากสถานะของ Job
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { ArchiveJobCliModule } from './archive-job.module';
import { ArchiveJobService, JobOutcome } from '../backup/archive-job.service';
import { ARCHIVE_TABLES, ArchiveTable, isArchiveTable } from '../backup/archive-tables';
import { isMonthString, MonthString } from '../backup/archive.util';
import { PG_POOL } from '../backup/backup.tokens';

const COMMANDS = ['export-and-drop', 'cleanup-restored', 'backfill', 'verify'] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `usage: archive-job <${COMMANDS.join('|')}> [options]
  --dry-run                   (export-and-drop, cleanup-restored, backfill) show what would happen
  --table=<name>[,<name>]     (export-and-drop, backfill, verify)
  --from=YYYY-MM --to=YYYY-MM (backfill, verify) inclusive month range
tables: ${ARCHIVE_TABLES.join(', ')}`;

export interface ParsedArgs {
  command: Command;
  dryRun: boolean;
  tables: ArchiveTable[] | undefined;
  from: MonthString | undefined;
  to: MonthString | undefined;
}

export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const [command, ...flags] = argv;
  if (!COMMANDS.includes(command as Command)) {
    return { error: `unknown command: ${command ?? ''}` };
  }
  const cmd = command as Command;
  let dryRun = false;
  let tables: ArchiveTable[] | undefined;
  let from: MonthString | undefined;
  let to: MonthString | undefined;

  for (const flag of flags) {
    if (flag === '--dry-run') {
      if (cmd === 'verify') return { error: '--dry-run is not valid for verify (it never writes)' };
      dryRun = true;
    } else if (flag.startsWith('--table=')) {
      if (cmd === 'cleanup-restored') return { error: '--table is not valid for cleanup-restored' };
      const names = flag.slice('--table='.length).split(',').filter(Boolean);
      const unknown = names.filter((n) => !isArchiveTable(n));
      if (unknown.length > 0) return { error: `unknown table: ${unknown.join(', ')}` };
      tables = names as ArchiveTable[];
    } else if (flag.startsWith('--from=') || flag.startsWith('--to=')) {
      if (cmd !== 'backfill' && cmd !== 'verify') {
        return { error: `${flag.split('=')[0]} is only valid for backfill and verify` };
      }
      const value = flag.slice(flag.indexOf('=') + 1);
      if (!isMonthString(value))
        return { error: `${flag.split('=')[0]} must be YYYY-MM, got "${value}"` };
      if (flag.startsWith('--from=')) from = value;
      else to = value;
    } else {
      return { error: `unknown option: ${flag}` };
    }
  }
  if (from && to && from > to) return { error: `--from (${from}) is after --to (${to})` };
  return { command: cmd, dryRun, tables, from, to };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(parsed.error);
    console.error(USAGE);
    return 2;
  }

  const app = await NestFactory.createApplicationContext(ArchiveJobCliModule);
  const logger = new Logger('archive-job');
  try {
    const jobs = app.get(ArchiveJobService);
    const range = { from: parsed.from, to: parsed.to };
    let outcome: JobOutcome;
    switch (parsed.command) {
      case 'cleanup-restored':
        outcome = await jobs.runCleanupRestored({ dryRun: parsed.dryRun });
        break;
      case 'backfill':
        outcome = await jobs.runBackfill({
          dryRun: parsed.dryRun,
          tables: parsed.tables,
          ...range,
        });
        break;
      case 'verify':
        outcome = await jobs.runVerify({ tables: parsed.tables, ...range });
        break;
      default:
        outcome = await jobs.runExportAndDrop({ dryRun: parsed.dryRun, tables: parsed.tables });
    }
    if (outcome.skipped) logger.warn('skipped: another instance is running');
    for (const failure of outcome.failures) logger.error(failure);
    logger.log(
      `${parsed.command} ${outcome.ok ? 'finished' : `failed (${outcome.failures.length} error(s))`}`,
    );
    return outcome.ok ? 0 : 1;
  } finally {
    // PG_POOL ถูกสร้างใน factory ไม่มี lifecycle hook ปิดให้ — ไม่ end() process จะค้างไม่จบ
    await app.get<Pool>(PG_POOL).end();
    await app.close();
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
      // กัน handle ที่หลุดปิด (เช่น S3 keep-alive) ทำให้ Job ค้างจน activeDeadlineSeconds
      setTimeout(() => process.exit(code), 10_000).unref();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
