import { ArrayMinSize, ArrayUnique, IsArray, IsString, MaxLength } from 'class-validator';

export class CreatePartnerApiKeyDto {
  /** ชื่อ/label ของ partner ที่ key นี้ออกให้ — ไม่ใช่ identity ที่ใช้ auth */
  @IsString()
  @MaxLength(150)
  name: string;

  /** allowlist ของ tenant (Devices.tenantId) ที่ key นี้เข้าถึงได้ — ดู ADR-0003/0004 */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  tenantIds: string[];
}
