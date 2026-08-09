import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { TimeRange } from '../../common/time/range.util';

export class QueryGraphDto {
  @IsEnum(TimeRange)
  @IsOptional()
  range?: TimeRange = TimeRange.DAY;

  @IsDateString()
  @IsOptional()
  from?: string;

  @IsDateString()
  @IsOptional()
  to?: string;

  /**
   * ดูเส้นเดียว — ไม่ระบุ = ทุก probe ของ device นั้น
   * series ของ probe อื่นจะไม่ถูกคืนมาเลย (ไม่ใช่คืนมาแบบ points ว่าง)
   */
  @IsUUID()
  @IsOptional()
  probeId?: string;
}
