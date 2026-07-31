import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateFirmwareDto {
  @IsString()
  @IsNotEmpty()
  version!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  // ไม่รับจาก client ตรง ๆ — เซ็ตโดย FirmwareService หลังอัปโหลดไฟล์ (field `file` ใน multipart request)
  // ขึ้น object storage สำเร็จ: fileKey, fileName, fileSize
}
