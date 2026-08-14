import { Readable } from 'node:stream';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { RedisService } from '../../src/redis/redis.service';
import { MqttClientService } from '../../src/mqtt/mqtt-client.service';
import { RabbitmqService } from '../../src/rabbitmq/rabbitmq.service';
import { ObjectStorageService } from '../../src/backup/object-storage.service';
import { FirmwareStorageService } from '../../src/firmware/firmware-storage.service';

/**
 * Redis stub แบบ in-memory
 *
 * เหตุผลสำคัญ: DeviceService cache 300 วินาที, notification 20s, graph 45s
 * ถ้าใช้ Redis จริง เทสจะเห็นข้อมูลค้างจากรอบก่อนแล้ว flaky
 * getOrSet ตัวนี้จึงเรียก factory ตรง ๆ ทุกครั้ง ไม่ cache เลย
 */
export class InMemoryRedisStub {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async delByPattern(): Promise<void> {
    this.store.clear();
  }

  /** ไม่ cache — เรียก factory ทุกครั้งเพื่อให้ assertion เห็นสถานะ DB ล่าสุดเสมอ */
  async getOrSet<T>(_key: string, _ttl: number, factory: () => Promise<T>): Promise<T> {
    return factory();
  }
}

/**
 * S3 stub แบบ in-memory สำหรับ FirmwareStorageService
 *
 * ต่างจาก ObjectStorageService stub (no-op ล้วน) เพราะ e2e ต้องทดสอบ GET /firmware/download/:version
 * จริง (ดาวน์โหลดไฟล์กลับมา stream ได้) ไม่ใช่แค่ยิง request แล้วเช็ค status code เฉย ๆ
 */
export class InMemoryFirmwareStorageStub {
  private readonly store = new Map<string, Buffer>();

  async upload(key: string, body: Buffer): Promise<string> {
    this.store.set(key, body);
    return key;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async getStream(key: string): Promise<Readable> {
    const body = this.store.get(key);
    if (!body) throw new Error(`no object stored for key ${key}`);
    return Readable.from(body);
  }
}

/** ตรงกับ app.setGlobalPrefix('log') ใน src/main.ts — ทุก URL ในเทสต้องผ่าน prefix นี้ */
export const API_PREFIX = '/log';

/**
 * รอ event listener แบบ fire-and-forget (EventEmitter2.emit ไม่ await) เขียนลง DB เสร็จ
 *
 * setImmediate() เดียวพอสำหรับ mock ในหน่วยเทส แต่ตัว e2e ต่อ DB จริงผ่านเครือข่าย
 * (round trip จริง ไม่ใช่ local) จึง poll จนกว่า condition จะเป็นจริงแทนการเดา tick เดียว
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  { retries = 20, intervalMs = 50 }: { retries?: number; intervalMs?: number } = {},
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * แกะ payload ออกจาก envelope ของ ResponseInterceptor
 * response สำเร็จทุกตัวถูกห่อเป็น { success, message, data, timestamp, statusCode }
 */
export function unwrap<T = any>(body: { data: T }): T {
  return body.data;
}

export interface TestAppMocks {
  mqtt: { publish: jest.Mock; publishNotification: jest.Mock; publishCommand: jest.Mock };
  rabbitmq: { emit: jest.Mock };
}

export interface TestAppContext {
  app: INestApplication;
  moduleRef: TestingModule;
  mocks: TestAppMocks;
}

export interface CreateTestAppOptions {
  /**
   * ปล่อยให้ RabbitmqService ต่อ broker จริง (ไม่ override ด้วย mock)
   * ใช้เฉพาะเทสที่ตั้งใจทดสอบ publish ผ่าน RabbitMQ จริง เช่น test/rmq-fcm-publish.e2e-spec.ts
   */
  realRabbitmq?: boolean;
}

/**
 * สร้าง Nest app สำหรับ e2e โดย override external dependency ทั้งหมด
 * (Redis / MQTT / RabbitMQ / S3) — เทสชุดนี้โฟกัส HTTP + DB + SSE ตามที่ตกลงไว้
 *
 * ไม่เรียก connectMicroservice/startAllMicroservices เพราะไม่มี MQTT/RabbitMQ broker ให้ต่อ
 * (ยกเว้นเทสที่เปิด microservice เองเพิ่มเติม เช่น rmq-consumer.e2e-spec.ts)
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestAppContext> {
  const mocks: TestAppMocks = {
    mqtt: {
      publish: jest.fn().mockResolvedValue(undefined),
      publishNotification: jest.fn().mockResolvedValue(undefined),
      publishCommand: jest.fn().mockResolvedValue(undefined),
    },
    rabbitmq: {
      emit: jest.fn().mockResolvedValue(undefined),
    },
  };

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RedisService)
    .useClass(InMemoryRedisStub)
    .overrideProvider(MqttClientService)
    .useValue(mocks.mqtt);

  if (!options.realRabbitmq) {
    builder = builder.overrideProvider(RabbitmqService).useValue(mocks.rabbitmq);
  }

  const moduleRef = await builder
    .overrideProvider(ObjectStorageService)
    .useValue({
      putObject: jest.fn().mockResolvedValue(undefined),
      getObjectStream: jest.fn(),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    })
    .overrideProvider(FirmwareStorageService)
    .useClass(InMemoryFirmwareStorageStub)
    .compile();

  const app = moduleRef.createNestApplication();

  // ต้องตรงกับ src/main.ts เป๊ะ ไม่งั้นเทส validation จะไม่สะท้อนพฤติกรรมจริง
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
  app.setGlobalPrefix(API_PREFIX.slice(1));

  await app.init();
  return { app, moduleRef, mocks };
}
