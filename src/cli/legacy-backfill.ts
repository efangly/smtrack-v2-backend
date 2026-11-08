/**
 * Legacy sync ขั้นที่ 2 (ADR-0007): backfill metadata ทั้งหมดจาก DB ของระบบเดิม
 *
 *   SOURCE_DATABASE_URL=postgresql://readonly@legacy/smtrack_device node dist/cli/legacy-backfill
 *
 * อ่านแต่ละแถวแล้วส่งเข้า LegacySyncService ตัวเดียวกับ consumer — backfill คือการ "replay snapshot"
 * จึงไม่มีตรรกะแปลงซ้ำสองที่ และรันซ้ำได้ (LWW ตาม updateAt ข้ามแถวที่ apply ไปแล้ว)
 * ต้องรันหลัง `npm run legacy-sync:setup` (queue เริ่มเก็บ message) และก่อนเปิด LEGACY_SYNC_ENABLED
 *
 * LogDays ไม่อยู่ในนี้ — copy ด้วย SQL ตาม scripts/migrate-legacy/README.md (unique index กันซ้ำให้แล้ว)
 * exit code: 0 = ครบ, 1 = มีแถวที่ apply ไม่ได้ (ดู log แล้วรันซ้ำได้)
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { LegacyBackfillCliModule } from './legacy-backfill.module';
import { LegacySyncService, SyncOutcome } from '../legacy-sync/legacy-sync.service';
import { validatePayload } from '../consumer/validate-payload.util';
import {
  LegacyConfigDto,
  LegacyDeviceDto,
  LegacyProbeDto,
  LegacyRepairDto,
  LegacyWarrantyDto,
} from '../legacy-sync/dto/legacy-snapshot.dto';

interface Step<T> {
  table: string;
  dto: new () => T;
  apply: (sync: LegacySyncService, row: T) => Promise<SyncOutcome>;
  /** ลำดับมีผล: probe/config อ้าง serial ของจุดติดตั้ง, repair/warranty อ้าง staticName */
  orderBy: string;
}

const STEPS: Step<any>[] = [
  {
    table: 'Devices',
    dto: LegacyDeviceDto,
    apply: (s, r) => s.upsertDevice(r),
    orderBy: '"createAt"',
  },
  {
    table: 'Probes',
    dto: LegacyProbeDto,
    apply: (s, r) => s.upsertProbe(r),
    orderBy: '"createAt"',
  },
  {
    table: 'Configs',
    dto: LegacyConfigDto,
    apply: (s, r) => s.upsertConfig(r),
    orderBy: '"createAt"',
  },
  { table: 'Repairs', dto: LegacyRepairDto, apply: (s, r) => s.upsertRepair(r), orderBy: '"seq"' },
  {
    table: 'Warranties',
    dto: LegacyWarrantyDto,
    apply: (s, r) => s.upsertWarranty(r),
    orderBy: '"createAt"',
  },
];

async function main(): Promise<number> {
  const logger = new Logger('LegacyBackfill');
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  if (!sourceUrl) {
    logger.error('SOURCE_DATABASE_URL is required (legacy smtrack-device DB, read-only user)');
    return 2;
  }

  const source = new Pool({ connectionString: sourceUrl });
  const app = await NestFactory.createApplicationContext(LegacyBackfillCliModule, {
    logger: ['log', 'warn', 'error'],
  });
  const sync = app.get(LegacySyncService);
  let failed = 0;

  try {
    for (const step of STEPS) {
      const counts: Record<SyncOutcome | 'failed', number> = {
        applied: 0,
        stale: 0,
        retired: 0,
        failed: 0,
      };
      const { rows } = await source.query(`SELECT * FROM "${step.table}" ORDER BY ${step.orderBy}`);
      for (const row of rows) {
        try {
          const dto = await validatePayload(step.dto, row);
          counts[await step.apply(sync, dto)] += 1;
        } catch (err) {
          counts.failed += 1;
          logger.warn(`${step.table} ${row.deviceId ?? row.id}: ${(err as Error).message}`);
        }
      }
      failed += counts.failed;
      logger.log(`${step.table}: ${JSON.stringify(counts)}`);
    }
  } finally {
    await source.end();
    await app.close();
  }
  return failed > 0 ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
