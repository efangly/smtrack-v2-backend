import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { MqttModule } from '../mqtt/mqtt.module';
import { SseModule } from '../sse/sse.module';
import { FcmModule } from '../fcm/fcm.module';
import { DeviceModule } from '../device/device.module';
import { ProbeModule } from '../probe/probe.module';

@Module({
  imports: [MqttModule, SseModule, FcmModule, DeviceModule, ProbeModule],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
