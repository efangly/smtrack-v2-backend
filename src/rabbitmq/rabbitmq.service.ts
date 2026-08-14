import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy, ClientProxyFactory } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { buildRmqFcmClientOptions } from '../config/rabbitmq.config';

/**
 * Event bus ภายในระหว่าง microservice
 * ปัจจุบันใช้ publish ข้อมูล push notification ไปยัง FCM service แยกต่างหาก (โปรเจคนี้เป็น producer เท่านั้น)
 */
@Injectable()
export class RabbitmqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitmqService.name);
  private fcmClient!: ClientProxy;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.fcmClient = ClientProxyFactory.create(buildRmqFcmClientOptions(this.config));
    await this.fcmClient.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.fcmClient?.close();
  }

  /**
   * publish event ผ่าน RabbitMQ แล้ว await จนกว่า broker รับ publish สำเร็จ
   * โยน error ออกไปให้ caller จัดการ (caller เป็นคนตัดสินใจว่า fail แล้วทำอะไรต่อ เช่น deliveredFcm=false)
   */
  async emit(pattern: string, payload: unknown): Promise<void> {
    await firstValueFrom(this.fcmClient.emit(pattern, payload));
    this.logger.debug(`published ${pattern}: ${JSON.stringify(payload)}`);
  }
}
