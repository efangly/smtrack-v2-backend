// ต้องมาก่อน import อื่นทั้งหมด เพื่อให้ OTel patch library ได้ทัน (import 'reflect-metadata' ต่อให้ข้างใน)
import './observability/tracing';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger as NestLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { buildMqttOptions } from './config/mqtt.config';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap(): Promise<void> {
  // buffer log ระหว่าง bootstrap ไว้ก่อน แล้วค่อย flush ออก pino หลัง useLogger
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  const logger = new NestLogger('Bootstrap');
  const config = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  // backend ไม่มี auth/cookie เลย จึงไม่ต้อง credentials: true — frontend ยิง request ตรงด้วย fetch/EventSource
  app.enableCors({ origin: config.get<AppConfig['corsOrigins']>('corsOrigins') });

  // hybrid app: attach MQTT microservice สำหรับ ingest log/telemetry จากอุปกรณ์
  app.connectMicroservice(buildMqttOptions(config), { inheritAppConfig: true });

  await app.startAllMicroservices();

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);
  logger.log(`HTTP server listening on :${port}`);
  logger.log('MQTT microservice connected');
}

void bootstrap();
