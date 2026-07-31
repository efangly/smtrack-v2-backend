import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateNotificationDto {
  @IsString()
  @IsNotEmpty()
  serial!: string;

  @IsString()
  @IsNotEmpty()
  message!: string;

  @IsString()
  @IsOptional()
  detail?: string;

  /**
   * channel ของ probe ที่เป็นต้นเหตุ (เลขช่องเดียวกับที่ส่งมาใน log) — ไม่ส่งมาถือว่าเป็น
   * การแจ้งเตือนระดับกล่อง (ไฟดับ/เน็ตหลุด/SD card) ที่ไม่ผูกกับ probe ตัวใดตัวหนึ่ง
   */
  @IsString()
  @IsOptional()
  probe?: string;
}
