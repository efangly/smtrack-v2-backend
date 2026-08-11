import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { RepairStatus } from '../enums/repair-status.enum';

export class QueryRepairDto extends PaginationQueryDto {
  @IsEnum(RepairStatus)
  @IsOptional()
  status?: RepairStatus;
}
