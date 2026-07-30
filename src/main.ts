// ต้องมาก่อน import อื่นทั้งหมด เพื่อให้ OTel patch library ได้ทัน (import 'reflect-metadata' ต่อให้ข้างใน)
import './observability/tracing';
import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, Logger as NestLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { buildMqttOptions } from './config/mqtt.config';
import { buildRmqOptions, buildRmqLogOptions } from './config/rabbitmq.config';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

// เผื่อ bootstrap พังก่อนที่ pino logger จะพร้อมใช้งาน (useLogger ยังไม่ถูกเรียก) —
// ต้อง log ผ่าน console ธรรมดา ไม่พึ่ง Nest/Pino logger ที่อาจยังไม่ flush ออกมา
process.on('unhandledRejection', (reason) => {
  console.error('[Bootstrap] Unhandled Rejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[Bootstrap] Uncaught Exception:', err);
  process.exit(1);
});

// กันไม่ให้ bootstrap ค้างเงียบตลอดไปเมื่อ dependency ภายนอก (DB/MQTT/RabbitMQ)
// connect ไม่สำเร็จแบบไม่ reject (เช่น broker คีย์ reconnect วนไม่รู้จบ)
const STARTUP_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Startup step timed out after ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

async function bootstrap(): Promise<void> {
  try {
    // buffer log ระหว่าง bootstrap ไว้ก่อน แล้วค่อย flush ออก pino หลัง useLogger
    const app = await withTimeout(
      NestFactory.create(AppModule, { bufferLogs: true }),
      STARTUP_TIMEOUT_MS,
      'NestFactory.create (module init / DB connect)',
    );
    app.useLogger(app.get(PinoLogger));

    const logger = new NestLogger('Bootstrap');
    const config = app.get(ConfigService);

    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
    app.setGlobalPrefix('log');

    // frontend ยิง request ตรงด้วย fetch/EventSource พร้อม Authorization header (ไม่ใช้ cookie) จึงไม่ต้อง credentials: true
    app.enableCors({ origin: '*' });

    // เปิด Swagger UI เฉพาะ non-production เพื่อไม่ให้เพิ่ม attack surface บนโปรดักชัน
    if (config.get<AppConfig['observability']>('observability')?.environment !== 'production') {
      const swaggerConfig = new DocumentBuilder()
        .setTitle('SMtrack v2 Backend API')
        .setDescription(
          'IoT Telemetry/Log ingestion + notification backend (NestJS + Prisma + TimescaleDB + MQTT). ' +
            'ทุก response สำเร็จถูกห่อด้วย { success, message, data, timestamp, statusCode } ' +
            'ผ่าน global ResponseInterceptor และ error ถูกห่อด้วย { success: false, message, data: null } ผ่าน HttpExceptionFilter',
        )
        .setVersion(process.env.npm_package_version ?? '0.1.0')
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'User JWT (login)' },
          'jwt',
        )
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Device auth token' },
          'device',
        )
        .build();
      const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
      SwaggerModule.setup('docs', app, swaggerDocument, { useGlobalPrefix: false });
    }

    // hybrid app: attach MQTT microservice สำหรับ ingest log/telemetry จากอุปกรณ์
    app.connectMicroservice(buildMqttOptions(config), { inheritAppConfig: true });
    // attach RabbitMQ microservice สำหรับ consume event ภายใน (เช่น device online/offline status)
    app.connectMicroservice(buildRmqOptions(config), { inheritAppConfig: true });
    // attach RabbitMQ microservice แยก queue สำหรับ consume log/telemetry (ปริมาณสูงกว่า ไม่ให้บล็อก queue ข้างบน)
    app.connectMicroservice(buildRmqLogOptions(config), { inheritAppConfig: true });

    await withTimeout(
      app.startAllMicroservices(),
      STARTUP_TIMEOUT_MS,
      'startAllMicroservices (MQTT/RabbitMQ connect)',
    );

    const port = config.get<number>('port') ?? 3000;
    await app.listen(port);
    logger.log(`HTTP server listening on :${port}`);
    logger.log('MQTT microservice connected');
    logger.log('RabbitMQ log consumer connected');
  } catch (err) {
    // ห้ามใช้ Nest/Pino logger ที่นี่ — จุดพังที่พบบ่อยที่สุดคือก่อน useLogger() ถูกเรียก
    // (log ที่ buffer ไว้จะไม่มีวัน flush ถ้า NestFactory.create() ไม่ resolve)
    console.error('[Bootstrap] Application failed to start:', err);
    process.exit(1);
  }
}

void bootstrap();
