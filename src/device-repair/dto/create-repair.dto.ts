import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateRepairDto {
  @IsString()
  @IsNotEmpty()
  serial!: string;

  @IsString()
  @IsOptional()
  devName?: string;

  @IsString()
  @IsOptional()
  info?: string;

  @IsString()
  @IsOptional()
  info1?: string;

  @IsString()
  @IsOptional()
  info2?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  ward?: string;

  @IsString()
  @IsOptional()
  detail?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsString()
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  warrantyStatus?: string;

  @IsString()
  @IsOptional()
  remark?: string;

  // ไม่รับ seq จาก client — เป็น autoincrement ที่ DB จัดการเอง
}
