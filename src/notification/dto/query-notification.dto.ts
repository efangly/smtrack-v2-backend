import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class NotificationQueryDto extends PaginationQueryDto {
  /** @deprecated ใช้ category/severity แทน — เก็บไว้เพื่อ backward-compat กับ frontend เดิม */
  @IsString()
  @IsOptional()
  filter?: string;

  @IsString()
  @IsOptional()
  category?: string;

  @IsString()
  @IsOptional()
  severity?: string;
}
