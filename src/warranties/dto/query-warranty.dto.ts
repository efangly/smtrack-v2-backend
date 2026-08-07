import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryWarrantyDto extends PaginationQueryDto {
  /** ค้นหาแบบ contains/insensitive จาก devName, customerName, product, model */
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : undefined;
  })
  @IsString()
  @IsOptional()
  search?: string;

  /** true = เฉพาะรายการที่ status=true และ expire ภายใน 30 วันข้างหน้า */
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    return value === true || value === 'true' || value === '1';
  })
  @IsBoolean()
  @IsOptional()
  expiringSoon?: boolean;
}
