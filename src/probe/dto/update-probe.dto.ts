import { PartialType } from '@nestjs/swagger';
import { CreateProbeDto } from './create-probe.dto';

export class UpdateProbeDto extends PartialType(CreateProbeDto) {}
