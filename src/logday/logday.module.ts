import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { LogdayService } from './logday.service';
import { LogdayController } from './logday.controller';

@Module({
  imports: [TelemetryModule],
  controllers: [LogdayController],
  providers: [LogdayService],
  exports: [LogdayService],
})
export class LogdayModule {}
