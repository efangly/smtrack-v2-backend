import { Controller, Get, Query } from '@nestjs/common';
import { LogDays } from '../generated/prisma/client';
import { TelemetryService } from './telemetry.service';
import { QueryTelemetryDto } from './dto/query-telemetry.dto';

@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly telemetryService: TelemetryService) {}

  @Get()
  find(@Query() query: QueryTelemetryDto): Promise<LogDays[]> {
    return this.telemetryService.find(query);
  }
}
