import { Transform } from 'class-transformer';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryDeviceDto extends PaginationQueryDto {
  /** กรองด้วย ward — รองรับค่าเดียว, comma-separated string, หรือ repeated query key (multi-select) */
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const values = Array.isArray(value) ? value : String(value).split(',');
    return values.map((v) => v.trim()).filter((v) => v.length > 0);
  })
  @IsString({ each: true })
  @IsOptional()
  ward?: string[];
}
