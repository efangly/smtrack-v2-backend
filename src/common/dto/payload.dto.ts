import { IsString, MaxLength } from 'class-validator';

// หมายเหตุ: ไม่มี hosId เหมือนต้นฉบับ เพราะ v2 ตัด field hospital ออกจาก schema แล้ว
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

  @IsString()
  @MaxLength(150)
  wardId: string;
}
