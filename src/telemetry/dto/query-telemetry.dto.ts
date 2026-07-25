import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class QueryTelemetryDto {
  /** กรองด้วยกล่องฮาร์ดแวร์ — ได้เฉพาะ log ที่กล่องนั้นยิงมา ไม่ว่าตอนนั้นติดตั้งอยู่ที่ไหน */
  @IsString()
  @IsOptional()
  serial?: string;

  /** กรองด้วยจุดติดตั้ง — ได้ประวัติต่อเนื่องข้ามการสลับเครื่อง (ใช้ device_id ที่ประทับตอน ingest) */
  @IsString()
  @IsOptional()
  deviceId?: string;

  @IsDateString()
  @IsOptional()
  from?: string;

  @IsDateString()
  @IsOptional()
  to?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  limit?: number = 100;
}
