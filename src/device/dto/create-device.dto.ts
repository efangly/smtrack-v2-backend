import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDate, IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateDeviceDto {
  @IsString()
  @IsNotEmpty()
  serial!: string;

  /** tenant ที่ frontend เลือกจากฟอร์ม — ผู้ใช้ที่ไม่ใช่ SUPER/SERVICE ต้องเป็น tenant ของตัวเอง */
  @IsString()
  @IsNotEmpty()
  tenantId!: string;

  @IsString()
  @IsNotEmpty()
  departmentId!: string;

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

  @IsString()
  @IsOptional()
  location?: string;

  @IsString()
  @IsOptional()
  tag?: string;

  // multipart/form-data ส่งทุก field เป็น string เสมอ ต้อง coerce เป็น Date ก่อน validate
  @Transform(({ value }) => (value ? new Date(value as string) : undefined))
  @IsDate()
  @IsOptional()
  installDate?: Date;

  // ไม่รับจาก client — เซ็ตโดย DeviceService หลังอัปโหลดไฟล์ (field `positionPic` ใน multipart request) ขึ้น object storage สำเร็จ

  // ไม่รับ `token` จาก client — controller นี้ไม่มี guard (ดูคอมเมนต์ใน device.controller.ts)
  // ถ้ารับจาก body จะเท่ากับเปิดให้ใครก็ได้เซ็ต credential ของอุปกรณ์ผ่าน POST /devices แบบไม่ต้อง auth
}
