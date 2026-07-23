import { Module } from '@nestjs/common';
import { DeviceModule } from '../device/device.module';
import { ConsumerController } from './consumer.controller';

@Module({
  imports: [DeviceModule],
  controllers: [ConsumerController],
})
export class ConsumerModule {}
