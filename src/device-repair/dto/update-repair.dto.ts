import { PartialType } from '@nestjs/swagger';
import { CreateRepairDto } from './create-repair.dto';

export class UpdateRepairDto extends PartialType(CreateRepairDto) {}
