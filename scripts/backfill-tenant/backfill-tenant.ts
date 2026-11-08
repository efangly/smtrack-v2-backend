import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';

/**
 * เติม tenant ให้ข้อมูลที่มีอยู่ก่อน ADR-0004 โดยอ่าน departments.id → tenant_id จาก DB ของ auth-service
 * (AUTH_DATABASE_URL) — ID ward เดิมคือ department ID ของ auth-service จึง map ได้ตรง ๆ
 *
 * - devices.tenant_id ที่ยังเป็น null → tenant ของ department_id
 * - snapshot ของ device ใน device_audit/user_audit ที่ยังไม่มี tenantId → เติมค่าเดียวกัน
 *   (diff คำนวณตอนอ่าน ADR-0001 — ไม่เติมแล้วการแก้ครั้งถัดไปจะโชว์ว่า tenantId ถูกเพิ่ม ทั้งที่ไม่มีใครแก้)
 * - partner_api_key_departments_legacy → partner_api_key_tenants (key เดิมเห็นทั้ง tenant ของ ward ที่เคยได้)
 *
 * รันซ้ำได้: แตะเฉพาะแถวที่ยังไม่มี tenant และ insert partner tenant แบบข้ามตัวซ้ำ
 * `--dry-run` นับอย่างเดียวไม่เขียน
 */

interface Summary {
  devicesUpdated: number;
  auditSnapshotsUpdated: number;
  partnerTenantsCreated: number;
  unmappedDepartments: string[];
}

async function loadDepartmentTenants(auth: Pool): Promise<Map<string, string>> {
  // รวม department ที่ถูก soft delete ด้วย — อุปกรณ์อาจยังอ้าง department ที่ถูกลบไปแล้ว
  const { rows } = await auth.query<{ id: string; tenant_id: string }>(
    'SELECT id, tenant_id FROM departments',
  );
  return new Map(rows.map((r) => [r.id, r.tenant_id]));
}

async function backfillDevices(
  target: PrismaClient,
  tenantOf: Map<string, string>,
  dryRun: boolean,
): Promise<Pick<Summary, 'devicesUpdated' | 'auditSnapshotsUpdated' | 'unmappedDepartments'>> {
  const pending = await target.devices.findMany({
    where: { tenantId: null },
    select: { id: true, departmentId: true },
  });

  let devicesUpdated = 0;
  let auditSnapshotsUpdated = 0;
  const unmapped = new Set<string>();

  for (const device of pending) {
    const tenantId = tenantOf.get(device.departmentId);
    if (!tenantId) {
      unmapped.add(device.departmentId);
      continue;
    }
    devicesUpdated += 1;
    if (dryRun) continue;

    await target
      .$transaction([
        target.devices.update({ where: { id: device.id }, data: { tenantId } }),
        target.$executeRaw`
        UPDATE "device_audit"
        SET "snapshot" = "snapshot" || jsonb_build_object('tenantId', ${tenantId}::text)
        WHERE "device_id" = ${device.id} AND NOT ("snapshot" ? 'tenantId')`,
        target.$executeRaw`
        UPDATE "user_audit"
        SET "snapshot" = "snapshot" || jsonb_build_object('tenantId', ${tenantId}::text)
        WHERE "entity_type" = 'device' AND "entity_id" = ${device.id}
          AND NOT ("snapshot" ? 'tenantId')`,
      ])
      .then(([, deviceAudit, userAudit]) => {
        auditSnapshotsUpdated += Number(deviceAudit) + Number(userAudit);
      });
  }

  return { devicesUpdated, auditSnapshotsUpdated, unmappedDepartments: [...unmapped].sort() };
}

async function backfillPartnerKeys(
  target: PrismaClient,
  tenantOf: Map<string, string>,
  dryRun: boolean,
  unmapped: Set<string>,
): Promise<number> {
  const legacy = await target.partnerApiKeyDepartmentsLegacy.findMany({
    select: { keyId: true, departmentId: true },
  });
  const existing = await target.partnerApiKeyTenants.findMany({
    select: { keyId: true, tenantId: true },
  });
  const seen = new Set(existing.map((e) => `${e.keyId}:${e.tenantId}`));

  let created = 0;
  for (const row of legacy) {
    const tenantId = tenantOf.get(row.departmentId);
    if (!tenantId) {
      unmapped.add(row.departmentId);
      continue;
    }
    const key = `${row.keyId}:${tenantId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    created += 1;
    if (!dryRun) {
      await target.partnerApiKeyTenants.create({ data: { keyId: row.keyId, tenantId } });
    }
  }
  return created;
}

async function main(): Promise<void> {
  const authUrl = process.env.AUTH_DATABASE_URL;
  if (!authUrl) throw new Error('AUTH_DATABASE_URL is required (auth-service DB)');
  const dryRun = process.argv.includes('--dry-run');

  const auth = new Pool({ connectionString: authUrl });
  const target = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    console.log(`backfilling tenant${dryRun ? ' (dry run — nothing is written)' : ''} ...`);
    const tenantOf = await loadDepartmentTenants(auth);
    console.log(`  auth-service departments: ${tenantOf.size}`);

    const devices = await backfillDevices(target, tenantOf, dryRun);
    const unmapped = new Set(devices.unmappedDepartments);
    const partnerTenantsCreated = await backfillPartnerKeys(target, tenantOf, dryRun, unmapped);

    console.log(`  devices: updated=${devices.devicesUpdated}`);
    console.log(`  audit snapshots: updated=${devices.auditSnapshotsUpdated}`);
    console.log(`  partner key tenants: created=${partnerTenantsCreated}`);
    if (unmapped.size > 0) {
      // ไม่เดา tenant ให้ — แถวเหล่านี้ยังเห็นได้เฉพาะ SUPER/SERVICE จนกว่าจะแก้ department ให้ถูก
      console.warn(
        `  departments not found in auth-service (left untouched): ${[...unmapped].sort().join(', ')}`,
      );
    }
    console.log('backfill done.');
  } finally {
    await target.$disconnect();
    await auth.end();
  }
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
