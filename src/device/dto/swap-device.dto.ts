import { IsOptional, IsString, IsNotEmpty, MaxLength } from 'class-validator';

/** สลับกล่องฮาร์ดแวร์ที่ติดตั้งอยู่ในจุดติดตั้งหนึ่ง (เช่น เครื่องเดิมพังแล้วเอาเครื่องใหม่มาแทน) */
export class SwapDeviceDto {
  /** serial ของกล่องใหม่ — ถ้ายังไม่เคยมีในระบบจะถูกสร้างให้อัตโนมัติ */
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  serial!: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  reason?: string;
}
