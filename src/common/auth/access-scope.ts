import { createHash } from 'node:crypto';

/**
 * ขอบเขตข้อมูลที่ผู้ใช้เห็นได้ — แปลงจาก JWT payload ที่ JwtStrategy เท่านั้น service อื่นอ่านแค่ค่านี้
 * ไม่อ่าน claim ตรง ๆ เพื่อให้ payload ของ auth-service เปลี่ยนได้โดยแก้ที่เดียว (ADR-0004)
 *
 * - GLOBAL: SUPER/SERVICE เห็นทุก tenant
 * - TENANT + 'ALL': เห็นทุก department ใน tenant ตัวเอง (ADMIN หรือ user ที่ได้สิทธิ์ทั้ง tenant)
 * - TENANT + string[]: เห็นเฉพาะ department ที่ระบุใน tenant ตัวเอง (ว่าง = ไม่เห็นอะไรเลย)
 */
export type AccessScope =
  { kind: 'GLOBAL' } | { kind: 'TENANT'; tenantId: string; departments: 'ALL' | string[] };

/** ตำแหน่งของข้อมูลชิ้นหนึ่ง — null = ยังไม่รู้ (เช่นกล่องที่ไม่ได้ติดตั้ง หรือยังไม่ backfill tenant) */
export interface DeviceLocation {
  tenantId: string | null;
  departmentId: string | null;
}

/**
 * scope ของโค้ดที่ไม่ได้ทำงานแทนผู้ใช้ — partner (ตรวจ tenant ของ key เอง) และ /adjust (ตั้งใจไม่ login)
 * ส่งค่านี้ให้ชัดว่าไม่กรอง แทนที่จะปล่อย scope เป็น optional ซึ่งลืมส่งแล้วกลายเป็นเห็นทุกอย่างเงียบ ๆ
 */
export const SYSTEM_SCOPE: AccessScope = { kind: 'GLOBAL' };

const GLOBAL_ROLES = new Set<string>(['SUPER', 'SERVICE']);
const TENANT_ADMIN_ROLES = new Set<string>(['ADMIN', 'LEGACY_ADMIN']);

/**
 * claim ของ access token ที่ใช้คำนวณ scope — `departmentScope` ยังไม่มีใน auth-service
 * (ดู docs/auth-service-claim-spec.md) ถ้าไม่มี user ทั่วไปเห็นตาม `departmentIds`
 */
export interface ScopeClaims {
  role: string;
  tenantId?: unknown;
  departmentIds?: unknown;
  departmentScope?: unknown;
}

/** คืน null ถ้า role ที่ต้องมี tenant แต่ token ไม่มี tenant — ผู้เรียกต้องปฏิเสธ ไม่ใช่ให้เห็นทุกอย่าง */
export function scopeFromClaims(claims: ScopeClaims): AccessScope | null {
  if (GLOBAL_ROLES.has(claims.role)) return { kind: 'GLOBAL' };

  const tenantId = typeof claims.tenantId === 'string' ? claims.tenantId : '';
  if (!tenantId) return null;

  if (TENANT_ADMIN_ROLES.has(claims.role) || claims.departmentScope === 'ALL') {
    return { kind: 'TENANT', tenantId, departments: 'ALL' };
  }
  const departments = Array.isArray(claims.departmentIds)
    ? claims.departmentIds.filter((d): d is string => typeof d === 'string')
    : [];
  return { kind: 'TENANT', tenantId, departments };
}

export function canAccess(scope: AccessScope, location: DeviceLocation): boolean {
  if (scope.kind === 'GLOBAL') return true;
  if (location.tenantId !== scope.tenantId) return false;
  if (scope.departments === 'ALL') return true;
  return location.departmentId !== null && scope.departments.includes(location.departmentId);
}

/** where ของ Devices ตาม scope — ใช้ร่วมกับ relation อื่นได้ เช่น `{ device: deviceWhere(scope) }` */
export function deviceWhere(scope: AccessScope): {
  tenantId?: string;
  departmentId?: { in: string[] };
} {
  if (scope.kind === 'GLOBAL') return {};
  if (scope.departments === 'ALL') return { tenantId: scope.tenantId };
  return { tenantId: scope.tenantId, departmentId: { in: scope.departments } };
}

/**
 * ส่วนของ cache key ที่แทน scope — ผู้ใช้ที่ scope เดียวกันใช้ cache ร่วมกัน และ hash ชุด department
 * ที่เรียงแล้วเพื่อไม่ให้ key ยาวตามจำนวน department
 */
export function scopeKey(scope: AccessScope): string {
  if (scope.kind === 'GLOBAL') return 'global';
  if (scope.departments === 'ALL') return `t:${scope.tenantId}:all`;
  const ids = [...scope.departments].sort().join(',');
  return `t:${scope.tenantId}:${createHash('sha1').update(ids).digest('hex').slice(0, 16)}`;
}
