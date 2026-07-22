import { Controller, Get, Param } from '@nestjs/common';
import { GraphService } from './graph.service';

@Controller('graph')
export class GraphController {
  constructor(private readonly graphService: GraphService) {}

  @Get(':serial')
  series(@Param('serial') serial: string) {
    return this.graphService.series(serial);
  }
}
