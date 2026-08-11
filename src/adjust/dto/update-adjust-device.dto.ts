import { IsOptional, IsString } from 'class-validator';

// subset ของ UpdateDeviceDto ที่ยอมให้อุปกรณ์แก้เองผ่าน endpoint ไม่มี auth ได้
// ไม่รับ staticName/ward/seq/status/positionPic ฯลฯ เพราะกระทบ routing/audit ของระบบส่วนกลาง
export class UpdateAdjustDeviceDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  remark?: string;

  @IsString()
  @IsOptional()
  position?: string;
}
