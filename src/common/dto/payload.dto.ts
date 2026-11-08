import { IsString, MaxLength } from 'class-validator';
import { AccessScope } from '../auth/access-scope';

/**
 * ผู้ใช้ที่ยืนยันตัวตนแล้ว (req.user) — ไม่มี tenantId/departmentIds ดิบ ๆ ให้อ่าน
 * ใช้ `scope` ที่ JwtStrategy คำนวณไว้แทนเสมอ (ดู common/auth/access-scope.ts)
 */
export class JwtPayloadDto {
  @IsString()
  @MaxLength(150)
  id: string;

  @IsString()
  @MaxLength(150)
  name: string;

  @IsString()
  @MaxLength(150)
  role: string;

  scope: AccessScope;
}
