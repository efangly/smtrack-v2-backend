import { Module } from '@nestjs/common';
import { MqttClientService } from './mqtt-client.service';
import { MqttController } from './mqtt.controller';
import { TelemetryModule } from '../telemetry/telemetry.module';

@Module({
  imports: [TelemetryModule],
  controllers: [MqttController],
  providers: [MqttClientService],
  exports: [MqttClientService],
})
export class MqttModule {}
