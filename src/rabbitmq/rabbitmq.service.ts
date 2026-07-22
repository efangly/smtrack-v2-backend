import { Injectable, Logger } from '@nestjs/common';

/**
 * Event bus ภายในระหว่าง microservice (scaffold)
 * ในรอบถัดไปจะ wire @nestjs/microservices RabbitMQ transport (ClientProxy) มาที่นี่
 */
@Injectable()
export class RabbitmqService {
  private readonly logger = new Logger(RabbitmqService.name);

  async emit(pattern: string, payload: unknown): Promise<void> {
    // TODO: publish ผ่าน RabbitMQ ClientProxy
    this.logger.debug(`(scaffold) emit ${pattern}: ${JSON.stringify(payload)}`);
  }
}
