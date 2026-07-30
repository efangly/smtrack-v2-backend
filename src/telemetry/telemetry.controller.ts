import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LogDays } from '../generated/prisma/client';
import { TelemetryService } from './telemetry.service';
import { QueryTelemetryDto } from './dto/query-telemetry.dto';
import { Paginated } from '../common/pagination/paginated.dto';

@ApiTags('telemetry')
@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly telemetryService: TelemetryService) {}

  @Get()
  find(@Query() query: QueryTelemetryDto): Promise<Paginated<LogDays>> {
    return this.telemetryService.find(query);
  }
}
