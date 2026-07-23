import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateDeviceDto {
  @IsString()
  @IsNotEmpty()
  serial!: string;

  @IsString()
  @IsNotEmpty()
  ward!: string;

  @IsString()
  @IsNotEmpty()
  staticName!: string;

  @IsString()
  @IsOptional()
  name?: string;

  // multipart/form-data ส่งทุก field เป็น string เสมอ ต้อง coerce เป็น boolean ก่อน validate
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  status!: boolean;

  // multipart/form-data ส่งทุก field เป็น string เสมอ ต้อง coerce เป็น number ก่อน validate
  @Type(() => Number)
  @IsInt()
  seq!: number;

  @IsString()
  @IsNotEmpty()
  firmware!: string;

  @IsString()
  @IsOptional()
  remark?: string;

  @IsString()
  @IsOptional()
  position?: string;

  // ไม่รับจาก client — เซ็ตโดย DeviceService หลังอัปโหลดไฟล์ (field `positionPic` ใน multipart request) ขึ้น object storage สำเร็จ
}
