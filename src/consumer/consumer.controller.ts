import { Controller } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { DeviceService } from '../device/device.service';
import { ackOrNack } from './rmq-ack.util';

interface DeviceStatusPayload {
  serial: string;
}

/**
 * รับ event สถานะ online/offline ของอุปกรณ์ผ่าน RabbitMQ (แทนที่ HTTP webhook แบบเดิม)
 * handler แยกจาก business logic — เรียก DeviceService เท่านั้น
 */
@Controller()
export class ConsumerController {
  constructor(private readonly deviceService: DeviceService) {}

  @EventPattern('device-online')
  async handleDeviceOnline(
    @Payload() payload: DeviceStatusPayload,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    await ackOrNack(context, 'device-online', payload, () =>
      this.deviceService.setOnline(payload.serial, true),
    );
  }

  @EventPattern('device-offline')
  async handleDeviceOffline(
    @Payload() payload: DeviceStatusPayload,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    await ackOrNack(context, 'device-offline', payload, () =>
      this.deviceService.setOnline(payload.serial, false),
    );
  }
}
