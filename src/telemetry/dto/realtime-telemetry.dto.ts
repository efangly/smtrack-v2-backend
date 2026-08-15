import { IsNumber, IsOptional, IsString, IsDateString } from 'class-validator';
import { Transform } from 'class-transformer';
import { normalizeToUtcIso } from './create-telemetry.dto';

/**
 * payload ของ topic realtime (ทุก ~5 วินาที, ไม่บันทึกลง DB) — ใช้แค่แสดงผลสดตอนปรับ
 * ค่าชดเชยอุณหภูมิ ต่างจาก CreateTelemetryDto (topic log ทุก 5 นาที ที่บันทึกจริง) จึงรับ
 * เฉพาะ field ที่จำเป็น ไม่ผูกกับ schema ของ LogDays ทั้งก้อน
 */
export class RealtimeTelemetryDto {
  /** optional เพราะอุปกรณ์อาจส่งมาแต่ topic โดยไม่ใส่ในตัว payload — เติมจาก topic ที่ handler */
  @IsString()
  @IsOptional()
  serial?: string;

  /** channel/probe — default '1' ที่ handler ถ้าไม่ระบุ */
  @IsString()
  @IsOptional()
  probe?: string;

  @IsNumber()
  @IsOptional()
  temp?: number;

  @Transform(({ value }) => normalizeToUtcIso(value))
  @IsDateString()
  @IsOptional()
  sendTime?: string;
}
