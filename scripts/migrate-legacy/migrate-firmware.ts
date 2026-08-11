import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { extname, basename } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../../src/generated/prisma/client';
import configuration, { AppConfig } from '../../src/config/configuration';
import { FirmwareStorageService } from '../../src/firmware/firmware-storage.service';

/**
 * One-shot: pulls the firmware file catalog from the legacy drive.siamatic.co.th file service
 * into this project's `Firmwares` table + `firmware.s3` MinIO bucket. See
 * scripts/migrate-legacy/README.md for field-mapping decisions (version = filename without
 * extension, createAt = original createDate from the drive API).
 *
 * Guarded, not idempotent-by-overwrite: a version that already exists in `Firmwares` is skipped
 * (Firmwares.version is immutable by convention — see firmware.service.ts `update()`).
 */

interface Summary {
  created: number;
  skipped: number;
}

function newSummary(): Summary {
  return { created: 0, skipped: 0 };
}

interface DriveFile {
  fileName: string;
  filePath: string;
  fileSize: string;
  createDate: string;
}

interface DriveListResponse {
  data: DriveFile[];
}

async function listDriveFiles(apiUrl: string, token: string): Promise<DriveFile[]> {
  const res = await fetch(`${apiUrl}/api/drive`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`GET /api/drive failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as DriveListResponse;
  return body.data;
}

async function downloadFile(
  apiUrl: string,
  token: string,
  filePath: string,
): Promise<{ buffer: Buffer; sha256: string }> {
  const res = await fetch(`${apiUrl}${filePath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`GET ${filePath} failed: ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const sha256 = createHash('sha256').update(buffer).digest('hex');

  return { buffer, sha256 };
}

/** drive API dates look like "2026-03-12 16:15:45" — no timezone; treat as-is (server local) */
function parseCreateDate(value: string): Date {
  const parsed = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`could not parse createDate "${value}"`);
  }
  return parsed;
}

async function migrateFirmware(
  apiUrl: string,
  token: string,
  target: PrismaClient,
  storage: FirmwareStorageService,
): Promise<Summary> {
  const summary = newSummary();
  const files = await listDriveFiles(apiUrl, token);
  console.log(`found ${files.length} firmware file(s) on the drive`);

  for (const file of files) {
    const version = basename(file.fileName, extname(file.fileName));

    const existing = await target.firmwares.findUnique({ where: { version } });
    if (existing) {
      console.warn(`[firmware] skip ${version}: already migrated`);
      summary.skipped += 1;
      continue;
    }

    const { buffer, sha256 } = await downloadFile(apiUrl, token, file.filePath);
    if (buffer.length === 0) {
      console.warn(`[firmware] skip ${version}: downloaded file is empty`);
      summary.skipped += 1;
      continue;
    }

    const fileKey = `firmware/${randomUUID()}${extname(file.fileName)}`;
    await storage.upload(fileKey, buffer, 'application/octet-stream');

    const createAt = parseCreateDate(file.createDate);
    try {
      await target.firmwares.create({
        data: {
          version,
          name: file.fileName,
          description: `migrated from drive.siamatic.co.th${file.filePath}`,
          fileKey,
          fileName: file.fileName,
          fileSize: buffer.length,
          checksum: sha256,
          createAt,
          updateAt: createAt,
        },
      });
    } catch (err) {
      await storage.delete(fileKey);
      throw err;
    }

    summary.created += 1;
    console.log(`[firmware] migrated ${version} (${buffer.length} bytes) -> s3://firmware/${fileKey}`);
  }

  return summary;
}

async function main(): Promise<void> {
  const apiUrl = (process.env.DRIVE_API_URL ?? 'https://drive.siamatic.co.th').replace(/\/$/, '');
  const token = process.env.DRIVE_API_TOKEN;
  if (!token) throw new Error('DRIVE_API_TOKEN is required (bearer token for drive.siamatic.co.th)');

  const pool = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const target = new PrismaClient({ adapter: pool });
  const configService = new ConfigService<AppConfig>(configuration());
  const storage = new FirmwareStorageService(configService);

  try {
    console.log('migrating firmware catalog from drive.siamatic.co.th ...');
    const summary = await migrateFirmware(apiUrl, token, target, storage);
    console.log(`  firmware: created=${summary.created} skipped=${summary.skipped}`);
    console.log('migration done.');
  } finally {
    await target.$disconnect();
  }
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
