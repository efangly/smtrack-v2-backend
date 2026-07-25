import { createHmac } from 'node:crypto';

/**
 * เซ็น JWT (HS256) สำหรับ e2e
 *
 * เขียนเองด้วย node:crypto แทนการเพิ่ม dependency `jsonwebtoken` เพราะเทสต้องการแค่ "เซ็น"
 * ส่วนการ verify เป็นหน้าที่ของ passport-jwt ในแอปจริงอยู่แล้ว — โครงสร้าง HS256 คือ
 * base64url(header).base64url(payload).base64url(HMAC-SHA256)
 */
const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds = 3600,
): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ ...payload, iat: issuedAt, exp: issuedAt + ttlSeconds });
  const signature = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

export interface UserClaims {
  id: string;
  name: string;
  role: string;
  wardId: string;
}

/** ward ตรงกับ buildDevices() ตัวแรก และ role SUPER ผ่าน RolesGuard ทุก endpoint */
const DEFAULT_USER: UserClaims = { id: 'e2e-user', name: 'E2E User', role: 'SUPER', wardId: 'OPD' };

/** Authorization header ของ user JWT (JwtAuthGuard) */
export function bearerUser(overrides: Partial<UserClaims> = {}): string {
  return `Bearer ${tokenUser(overrides)}`;
}

/** token ดิบ (ไม่มี `Bearer `) สำหรับ SSE ที่ส่ง token ทาง query param */
export function tokenUser(overrides: Partial<UserClaims> = {}): string {
  return signJwt({ ...DEFAULT_USER, ...overrides }, process.env.JWT_SECRET as string);
}

/** Authorization header ของ device JWT (DeviceJwtAuthGuard) — `sn` คือ serial ของอุปกรณ์ */
export function bearerDevice(sn: string): string {
  return `Bearer ${signJwt({ sn }, process.env.DEVICE_SECRET as string)}`;
}
