import { Transport, RmqOptions } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from './configuration';

/**
 * สร้าง options สำหรับ RabbitMQ microservice transport
 * ใช้สำหรับ consume event ภายใน (เช่น device online/offline status) ไม่ใช่การสื่อสารกับอุปกรณ์โดยตรง
 */
export const buildRmqOptions = (config: ConfigService): RmqOptions => ({
  transport: Transport.RMQ,
  options: {
    urls: [config.get<string>('rabbitmqUrl') ?? 'amqp://localhost:5672'],
    queue: config.get<string>('rabbitmq.deviceOnlineQueue') ?? 'device_online_queue',
    queueOptions: { durable: true },
    noAck: false,
  },
});

/**
 * Queue แยกต่างหากสำหรับ consume log/telemetry ผ่าน RabbitMQ (เช่น จาก gateway/service ต้นทางอื่น)
 * แยก connection จาก device online/offline เพราะปริมาณ log สูงกว่ามาก ไม่ให้บล็อกกัน
 */
export const buildRmqLogOptions = (config: ConfigService): RmqOptions => ({
  transport: Transport.RMQ,
  options: {
    urls: [config.get<string>('rabbitmqUrl') ?? 'amqp://localhost:5672'],
    queue: config.get<string>('rabbitmq.logQueue') ?? 'log_queue',
    queueOptions: { durable: true },
    noAck: false,
  },
});

/**
 * Legacy sync (ADR-0007): queue เดียวรับทุกอย่างที่ระบบเดิม publish เข้า topic exchange `legacy.sync`
 * ทั้ง metadata (`legacy.<entity>.*`) และ runtime event (`device-log`, `device-notification`, …) —
 * handler ถูก route ตาม pattern ใน envelope จึงไปถึง consumer เดิมได้แม้มาจาก queue นี้
 *
 * - `x-single-active-consumer` + prefetch 1: ประมวลผลทีละ message ตามลำดับ แม้รันหลาย replica
 *   (snapshot ของ entity เดียวกันจะไม่แข่งกันเขียน)
 * - nack (ไม่ requeue) → dead-letter เข้า DLQ ให้ตรวจ/replay ทีหลัง
 *
 * ⚠️ queueOptions ต้องตรงกับ scripts/legacy-sync/setup-queue.ts ทุกตัว ไม่งั้น assertQueue จะ PRECONDITION_FAILED
 */
export const legacySyncQueueArguments = (deadLetterQueue: string) => ({
  'x-single-active-consumer': true,
  'x-dead-letter-exchange': '',
  'x-dead-letter-routing-key': deadLetterQueue,
});

export const LEGACY_SYNC_ROUTING_KEY = '#';

export const buildRmqLegacySyncOptions = (config: ConfigService): RmqOptions => {
  const legacy = config.get<AppConfig['legacySync']>('legacySync');
  const deadLetterQueue = legacy?.deadLetterQueue ?? 'legacy_sync_dlq';
  return {
    transport: Transport.RMQ,
    options: {
      urls: [config.get<string>('rabbitmqUrl') ?? 'amqp://localhost:5672'],
      queue: legacy?.queue ?? 'legacy_sync_queue',
      queueOptions: { durable: true, arguments: legacySyncQueueArguments(deadLetterQueue) },
      exchange: legacy?.exchange ?? 'legacy.sync',
      exchangeType: 'topic',
      routingKey: LEGACY_SYNC_ROUTING_KEY,
      prefetchCount: 1,
      noAck: false,
    },
  };
};

/** message pattern ที่ฝั่ง FCM service (แยกต่างหาก) ต้อง @EventPattern ให้ตรงกัน */
export const FCM_PUSH_PATTERN = 'fcm-push';

/**
 * Client options สำหรับ publish ข้อมูล push notification ไปยัง FCM service แยกต่างหาก
 * โปรเจคนี้เป็นฝั่ง producer เท่านั้น — service ที่ consume queue นี้แล้วยิง push จริงอยู่นอกโปรเจค
 */
export const buildRmqFcmClientOptions = (config: ConfigService): RmqOptions => ({
  transport: Transport.RMQ,
  options: {
    urls: [config.get<string>('rabbitmqUrl') ?? 'amqp://localhost:5672'],
    queue: config.get<string>('rabbitmq.fcmQueue') ?? 'fcm_notification_queue',
    queueOptions: { durable: true },
  },
});
