import { PartialType } from '@nestjs/swagger';
import { CreateTelemetryDto } from '../../telemetry/dto/create-telemetry.dto';

export class UpdateLogdayDto extends PartialType(CreateTelemetryDto) {}
