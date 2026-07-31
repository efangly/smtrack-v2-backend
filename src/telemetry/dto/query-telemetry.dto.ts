import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryTelemetryDto extends PaginationQueryDto {
  /** กรองด้วยกล่องฮาร์ดแวร์ — ได้เฉพาะ log ที่กล่องนั้นยิงมา ไม่ว่าตอนนั้นติดตั้งอยู่ที่ไหน */
  @IsString()
  @IsOptional()
  serial?: string;

  /** กรองด้วยจุดติดตั้ง — ได้ประวัติต่อเนื่องข้ามการสลับเครื่อง (ใช้ device_id ที่ประทับตอน ingest) */
  @IsString()
  @IsOptional()
  deviceId?: string;

  /** กรองด้วย probe ตรง ๆ (Probes.id) — ใช้เมื่อรู้ probe อยู่แล้ว เช่นกดเจาะจากเส้นในกราฟ */
  @IsUUID()
  @IsOptional()
  probeId?: string;

  /**
   * กรองด้วย channel ที่อุปกรณ์ส่งมา (`log_days.probe`) — ไม่ใช่ตัวเดียวกับ `probeId`
   * channel ซ้ำได้ข้าม device จึงควรใช้คู่กับ `serial`/`deviceId` ไม่งั้นได้ log ของทุก device
   */
  @IsString()
  @IsOptional()
  probe?: string;

  @IsDateString()
  @IsOptional()
  from?: string;

  @IsDateString()
  @IsOptional()
  to?: string;

  // telemetry เป็น time-series volume สูง เลย override ขอบเขตของ limit ให้กว้างกว่า default ของ PaginationQueryDto
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  limit?: number = 100;
}
