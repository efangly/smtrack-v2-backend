import { Logger } from '@nestjs/common';
import { RmqContext } from '@nestjs/microservices';

const logger = new Logger('RmqAck');

/**
 * รัน operation แล้ว ack เมื่อสำเร็จ / nack แบบไม่ requeue เมื่อพัง (payload ผิดรูปแบบ retry ไปก็ไม่มีทางสำเร็จ)
 * ใช้ร่วมกันทุก RabbitMQ consumer handler เพื่อไม่ให้ ack/nack logic ซ้ำ
 */
export async function ackOrNack(
  context: RmqContext,
  eventName: string,
  payload: unknown,
  operation: () => Promise<unknown>,
): Promise<void> {
  const channel = context.getChannelRef();
  const message = context.getMessage();
  try {
    await operation();
    channel.ack(message);
  } catch (error) {
    logger.error(
      `Failed to process ${eventName}: ${JSON.stringify(payload)}`,
      error instanceof Error ? error.stack : String(error),
    );
    channel.nack(message, false, false);
  }
}
