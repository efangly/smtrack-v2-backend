import { Transport, RmqOptions } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';

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
