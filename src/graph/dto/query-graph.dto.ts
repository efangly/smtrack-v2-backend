import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';

export enum GraphRange {
  DAY = '1d',
  WEEK = '7d',
  MONTH = '30d',
  CUSTOM = 'custom',
}

export class QueryGraphDto {
  @IsEnum(GraphRange)
  @IsOptional()
  range?: GraphRange = GraphRange.DAY;

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
