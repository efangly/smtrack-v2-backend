import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { LogConsumerController } from './log-consumer.controller';

@Module({
  imports: [TelemetryModule],
  controllers: [LogConsumerController],
})
export class LogConsumerModule {}
