import { Controller, Get, Param } from '@nestjs/common';
import { LogdayService } from './logday.service';

@Controller('logday')
export class LogdayController {
  constructor(private readonly logdayService: LogdayService) {}

  @Get(':serial')
  summary(@Param('serial') serial: string) {
    return this.logdayService.summaryBySerial(serial);
  }
}
