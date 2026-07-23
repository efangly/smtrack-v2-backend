import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GraphService } from './graph.service';
import { JwtAuthGuard } from '../common/guards/jwt.guard';

@ApiTags('graph')
@ApiBearerAuth('jwt')
@Controller('graph')
@UseGuards(JwtAuthGuard)
export class GraphController {
  constructor(private readonly graphService: GraphService) {}

  @Get(':serial')
  series(@Param('serial') serial: string) {
    return this.graphService.series(serial);
  }
}
