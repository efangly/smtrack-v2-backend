import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

/**
 * รับ event จาก RabbitMQ แล้วส่งต่อ business logic (scaffold)
 * handler แยกจาก business logic — เรียก service เมื่อเติม logic จริง
 */
@Controller()
export class ConsumerController {
  private readonly logger = new Logger(ConsumerController.name);

  @EventPattern('internal.example')
  handleExample(@Payload() payload: unknown): void {
    this.logger.debug(`(scaffold) consumed internal.example: ${JSON.stringify(payload)}`);
  }
}
