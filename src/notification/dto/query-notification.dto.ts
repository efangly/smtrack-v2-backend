import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class NotificationQueryDto extends PaginationQueryDto {
  @IsString()
  @IsOptional()
  filter?: string;
}
