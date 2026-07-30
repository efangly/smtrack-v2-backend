import 'dotenv/config';
import { randomUUID, createHash, Hash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { PassThrough, Readable, Transform, TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MongoClient, Db } from 'mongodb';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import configuration, { AppConfig } from '../../src/config/configuration';
import { ObjectStorageService } from '../../src/backup/object-storage.service';
import {
  archiveObjectKey,
  metaObjectKey,
  monthRange,
  MonthString,
} from '../../src/backup/archive.util';
import { LOG_DAYS_COLUMNS, ArchiveMeta } from '../../src/backup/archive-export.service';

/**
 * One-shot: pulls the legacy efangly/smtrack-backup MongoDB shadow copy (collections
 * `notifications` and `logdays`) into this project. `notifications` goes straight into the live
 * table; `logdays` is routed through the existing S3 archive pipeline (src/backup) instead of the
 * live LogDays table, since it's historical data. `templogs` is intentionally skipped — no target
 * model exists for the mcuId-keyed legacy TempLogs entity. See README.md for details.
 *
 * Not idempotent for notifications: Mongo docs don't reliably carry the original Postgres UUID,
 * so re-running creates duplicates. Log-day months are guarded (skipped unless --force) since they
 * write to shared object storage.
 */

interface Summary {
  created: number;
  skipped: number;
}

function newSummary(): Summary {
  return { created: 0, skipped: 0 };
}

interface LegacyNotification {
  id?: string;
  serial: string;
  staticName?: string;
  message: string;
  detail: string;
  status?: boolean;
  createAt?: Date | string;
  updateAt?: Date | string;
}

interface LegacyLogDay {
  id?: string;
  serial: string;
  staticName?: string;
  temp?: number;
  tempDisplay?: number;
  humidity?: number;
  humidityDisplay?: number;
  sendTime: Date | string;
  plug?: boolean;
  door1?: boolean;
  door2?: boolean;
  door3?: boolean;
  internet?: boolean;
  probe?: string;
  battery?: number;
  tempInternal?: number | null;
  extMemory?: boolean;
  createAt?: Date | string;
  updateAt?: Date | string;
}

const NOTIFICATION_BATCH_SIZE = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function toCsvRow(values: readonly string[]): string {
  return values.map(csvEscape).join(',') + '\n';
}

/** counts CSV lines + sha256 of the pre-gzip bytes as they flow through */
class CsvStats extends Transform {
  lines = 0;
  readonly hash: Hash = createHash('sha256');

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    for (const byte of chunk) if (byte === 0x0a) this.lines++;
    this.hash.update(chunk);
    cb(null, chunk);
  }
}

async function migrateNotifications(
  mongoDb: Db,
  target: PrismaClient,
  serialToDeviceId: Map<string, string>,
): Promise<Summary> {
  const summary = newSummary();
  const cursor = mongoDb.collection<LegacyNotification>('notifications').find();

  let batch: {
    serial: string;
    message: string;
    detail: string;
    status: boolean;
    deliveredSse: boolean;
    deliveredFcm: boolean;
    deviceId: string;
    createAt: Date;
    updateAt: Date;
  }[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    await target.notifications.createMany({ data: batch });
    summary.created += batch.length;
    batch = [];
  };

  for await (const doc of cursor) {
    const deviceId = serialToDeviceId.get(doc.serial);
    if (!deviceId) {
      console.warn(
        `[notifications] skip ${doc.id ?? doc.serial}: no device for serial=${doc.serial}`,
      );
      summary.skipped += 1;
      continue;
    }
    batch.push({
      serial: doc.serial,
      message: doc.message,
      detail: doc.detail,
      status: doc.status ?? false,
      deliveredSse: true,
      deliveredFcm: true,
      deviceId,
      createAt: doc.createAt ? new Date(doc.createAt) : new Date(),
      updateAt: doc.updateAt ? new Date(doc.updateAt) : new Date(),
    });
    if (batch.length >= NOTIFICATION_BATCH_SIZE) await flush();
  }
  await flush();

  return summary;
}

async function listMonths(mongoDb: Db): Promise<MonthString[]> {
  const months = await mongoDb
    .collection('logdays')
    .aggregate<{ _id: string }>([
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$sendTime' } } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  // Skip the current in-progress month — it's still receiving writes, so a count taken
  // before the streaming read finishes can't match a count taken after. Same rule the app's
  // own cron follows (archive-export.service.ts only ever exports the previous month).
  const currentMonth = new Date().toISOString().slice(0, 7);
  return months.map((m) => m._id as MonthString).filter((m) => m !== currentMonth);
}

async function migrateLogDaysMonth(
  mongoDb: Db,
  target: PrismaClient,
  storage: ObjectStorageService,
  serialToDeviceId: Map<string, string>,
  month: MonthString,
  force: boolean,
): Promise<Summary> {
  const summary = newSummary();
  const key = archiveObjectKey(month);

  if (!force && (await storage.exists(key))) {
    console.warn(`[logdays] skip ${month}: archive object already exists at ${key} (use --force)`);
    summary.skipped += 1;
    return summary;
  }

  const { from, to } = monthRange(month);
  const mongoCount = await mongoDb
    .collection('logdays')
    .countDocuments({ sendTime: { $gte: from, $lt: to } });

  const cursor = mongoDb
    .collection<LegacyLogDay>('logdays')
    .find({ sendTime: { $gte: from, $lt: to } })
    .sort({ sendTime: 1 })
    .allowDiskUse(true);

  async function* rows(): AsyncGenerator<string> {
    yield LOG_DAYS_COLUMNS.join(',') + '\n';
    for await (const doc of cursor) {
      const id = doc.id && UUID_RE.test(doc.id) ? doc.id : randomUUID();
      const deviceId = serialToDeviceId.get(doc.serial) ?? '';
      yield toCsvRow([
        id,
        doc.serial,
        String(doc.temp ?? 0),
        String(doc.tempDisplay ?? 0),
        String(doc.humidity ?? 0),
        String(doc.humidityDisplay ?? 0),
        new Date(doc.sendTime).toISOString(),
        String(doc.plug ?? false),
        String(doc.door1 ?? false),
        String(doc.door2 ?? false),
        String(doc.door3 ?? false),
        String(doc.internet ?? false),
        doc.probe ?? '1',
        String(doc.battery ?? 0),
        String(doc.tempInternal ?? 0),
        String(doc.extMemory ?? false),
        doc.createAt ? new Date(doc.createAt).toISOString() : new Date().toISOString(),
        doc.updateAt ? new Date(doc.updateAt).toISOString() : new Date().toISOString(),
        deviceId,
      ]);
    }
  }

  const stats = new CsvStats();
  const body = new PassThrough();
  const uploadDone = storage.uploadStream(key, body, 'application/gzip');
  await pipeline(Readable.from(rows()), stats, createGzip({ level: 6 }), body);
  await uploadDone;

  const rowCount = Math.max(0, stats.lines - 1); // minus header line

  if (rowCount !== mongoCount) {
    await storage.delete(key);
    throw new Error(
      `[logdays] row count mismatch for ${month}: mongo=${mongoCount}, file=${rowCount}`,
    );
  }

  const meta: ArchiveMeta = {
    month,
    rowCount,
    sha256: stats.hash.digest('hex'),
    exportedAt: new Date().toISOString(),
    columns: LOG_DAYS_COLUMNS,
  };
  await storage.putJson(metaObjectKey(month), meta);

  await target.archiveExport.upsert({
    where: { month: from },
    create: { month: from, rowCount: BigInt(rowCount), objectKey: key, sha256: meta.sha256 },
    update: {
      rowCount: BigInt(rowCount),
      objectKey: key,
      sha256: meta.sha256,
      exportedAt: new Date(),
    },
  });

  summary.created += rowCount;
  console.log(`[logdays] archived ${month}: ${rowCount} rows -> s3://${storage.bucket}/${key}`);
  return summary;
}

async function migrateLogDaysToArchive(
  mongoDb: Db,
  target: PrismaClient,
  storage: ObjectStorageService,
  serialToDeviceId: Map<string, string>,
  force: boolean,
): Promise<Summary> {
  const summary = newSummary();
  const months = await listMonths(mongoDb);
  for (const month of months) {
    const monthSummary = await migrateLogDaysMonth(
      mongoDb,
      target,
      storage,
      serialToDeviceId,
      month,
      force,
    );
    summary.created += monthSummary.created;
    summary.skipped += monthSummary.skipped;
  }
  return summary;
}

async function main(): Promise<void> {
  const mongoUrl = process.env.MONGO_BACKUP_URL;
  if (!mongoUrl) throw new Error('MONGO_BACKUP_URL is required (legacy smtrack-backup MongoDB)');
  const force = process.argv.includes('--force');
  const skipNotifications = process.argv.includes('--skip-notifications');

  const mongoClient = new MongoClient(mongoUrl);
  const target = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const configService = new ConfigService<AppConfig>(configuration());
  const storage = new ObjectStorageService(configService);

  try {
    await mongoClient.connect();
    const mongoDb = mongoClient.db();

    console.log('resolving device serials ...');
    const devices = await target.devices.findMany({ where: { serial: { not: null } } });
    const serialToDeviceId = new Map<string, string>(
      devices.filter((d) => d.serial).map((d) => [d.serial as string, d.id]),
    );
    console.log(`  resolved ${serialToDeviceId.size} device serials`);

    if (skipNotifications) {
      console.log('migrating notifications ... skipped (--skip-notifications)');
    } else {
      console.log('migrating notifications ...');
      const notificationsSummary = await migrateNotifications(mongoDb, target, serialToDeviceId);
      console.log(
        `  notifications: created=${notificationsSummary.created} skipped=${notificationsSummary.skipped}`,
      );
    }

    console.log('migrating logdays -> archive pipeline ...');
    const logDaysSummary = await migrateLogDaysToArchive(
      mongoDb,
      target,
      storage,
      serialToDeviceId,
      force,
    );
    console.log(`  logdays: archived=${logDaysSummary.created} skipped=${logDaysSummary.skipped}`);

    console.log('templogs: skipped (no target model for legacy TempLogs)');
    console.log('migration done.');
  } finally {
    await target.$disconnect();
    await mongoClient.close();
  }
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
