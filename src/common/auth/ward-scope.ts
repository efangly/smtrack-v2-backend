import { JwtPayloadDto } from '../dto/payload.dto';

/**
 * role ที่เห็นได้เฉพาะ ward ของตัวเอง — role อื่น (SUPER/SERVICE/ADMIN) เห็นทุก ward
 *
 * ยึดตามคอนเวนชันเดิมของ findCondition() ใน notification.service / mobile.service
 * โดยรวม GUEST ไว้ด้วยแบบเดียวกับฝั่ง mobile (เข้มกว่าเสมอปลอดภัยกว่าสำหรับ stream ที่ push เอง)
 */
const WARD_SCOPED_ROLES = new Set<string>(['USER', 'LEGACY_USER', 'GUEST']);

export function isWardScoped(user: Pick<JwtPayloadDto, 'role'>): boolean {
  return WARD_SCOPED_ROLES.has(user.role);
}
