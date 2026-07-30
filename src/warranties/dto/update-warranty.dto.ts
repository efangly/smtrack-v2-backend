import { PartialType } from '@nestjs/swagger';
import { CreateWarrantyDto } from './create-warranty.dto';

export class UpdateWarrantyDto extends PartialType(CreateWarrantyDto) {}
