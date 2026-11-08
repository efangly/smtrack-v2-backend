import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { LogDays } from '../generated/prisma/client';
import { TelemetryService } from './telemetry.service';
import { QueryTelemetryDto } from './dto/query-telemetry.dto';
import { Paginated } from '../common/pagination/paginated.dto';

@ApiTags('telemetry')
@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly telemetryService: TelemetryService) {}

  @Get()
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard)
  find(
    @Query() query: QueryTelemetryDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Paginated<LogDays>> {
    return this.telemetryService.find(query, req.user.scope);
  }
}
