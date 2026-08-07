import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { NotificationModule } from '../notification/notification.module';
import { LogConsumerController } from './log-consumer.controller';
import { NotificationConsumerController } from './notification-consumer.controller';

// ทั้งสอง controller ผูกกับ log_queue เดียวกัน (buildRmqLogOptions) แยกกันด้วย EventPattern
@Module({
  imports: [TelemetryModule, NotificationModule],
  controllers: [LogConsumerController, NotificationConsumerController],
})
export class LogConsumerModule {}
