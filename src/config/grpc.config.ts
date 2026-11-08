import { join } from 'node:path';
import { Transport, GrpcOptions } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';

/**
 * Partner API (third-party) gRPC transport — เดียวที่ใช้ gRPC ในโปรเจคนี้ ที่เหลือเป็น
 * MQTT/RabbitMQ/REST ตาม CLAUDE.md เสมอ ดู docs/adr/0003-partner-api-keys-scope-by-ward.md
 * และ docs/adr/0004-device-tenant-scope.md
 *
 * protoPath ต้องหาไฟล์ให้เจอทั้งตอนรันจาก source (ts-node/jest, __dirname = src/config) และ
 * ตอน build แล้ว (__dirname = dist/src/config) — nest-cli.json คัด partner/*.proto เข้า
 * dist/src/partner/ ให้แล้วผ่าน compilerOptions.assets จึง join แบบ relative เดียวกันได้ทั้งคู่
 */
export const buildGrpcOptions = (config: ConfigService): GrpcOptions => ({
  transport: Transport.GRPC,
  options: {
    package: 'partner',
    protoPath: join(__dirname, '../partner/partner.proto'),
    url: config.get<string>('grpcUrl') ?? '0.0.0.0:50051',
    // enum ส่ง/รับเป็นชื่อ (เช่น "DAY_7") ไม่ใช่ตัวเลข — default ของ proto-loader คือตัวเลข ซึ่งทำให้
    // handler เห็น range เป็น 2 แทน "DAY_7" (client ฝั่ง partner ควรตั้ง loader { enums: String } เหมือนกัน)
    loader: { enums: String },
  },
});
