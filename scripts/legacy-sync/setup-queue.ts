/**
 * Legacy sync ขั้นที่ 1 (ADR-0007, docs/legacy-sync-contract.md): สร้าง exchange + queue + DLQ + binding
 * ไว้ก่อน "โดยยังไม่ consume" — message ที่ระบบเดิม publish ระหว่าง backfill จะค้างรอใน queue
 * แล้วค่อยถูกดูดเมื่อเปิด LEGACY_SYNC_ENABLED=true (ขั้นที่ 3)
 *
 *   npm run legacy-sync:setup
 *
 * idempotent — รันซ้ำได้ แต่ argument ของ queue ต้องตรงกับ buildRmqLegacySyncOptions เสมอ
 * (ใช้ legacySyncQueueArguments ตัวเดียวกัน) ไม่งั้น RabbitMQ จะตอบ PRECONDITION_FAILED
 */
import 'dotenv/config';
import * as amqplib from 'amqplib';
import {
  LEGACY_SYNC_ROUTING_KEY,
  legacySyncQueueArguments,
} from '../../src/config/rabbitmq.config';

async function main(): Promise<void> {
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL is required');
  const exchange = process.env.RABBITMQ_LEGACY_EXCHANGE ?? 'legacy.sync';
  const queue = process.env.RABBITMQ_LEGACY_SYNC_QUEUE ?? 'legacy_sync_queue';
  const dlq = process.env.RABBITMQ_LEGACY_SYNC_DLQ ?? 'legacy_sync_dlq';

  const conn = await amqplib.connect(url);
  try {
    const ch = await conn.createChannel();
    await ch.assertExchange(exchange, 'topic', { durable: true });
    await ch.assertQueue(dlq, { durable: true });
    await ch.assertQueue(queue, { durable: true, arguments: legacySyncQueueArguments(dlq) });
    await ch.bindQueue(queue, exchange, LEGACY_SYNC_ROUTING_KEY);
    const { messageCount } = await ch.checkQueue(queue);
    console.log(
      `ready: exchange=${exchange} (topic) → queue=${queue} [${LEGACY_SYNC_ROUTING_KEY}], dlq=${dlq}; ` +
        `${messageCount} message(s) waiting`,
    );
    await ch.close();
  } finally {
    await conn.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
