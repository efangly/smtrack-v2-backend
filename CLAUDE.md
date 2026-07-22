## ภาพรวมโปรเจค

ระบบรับ-ประมวลผล-จัดเก็บข้อมูล IoT Telemetry/Log และแจ้งเตือน (notification) ผ่านโปรโตคอล MQTT โดยใช้ NestJS เป็น backend framework และ Prisma เป็น ORM สำหรับติดต่อฐานข้อมูล

แนวทางโมดูลและ feature set ออกแบบโดยอ้างอิง [smtrack-log](https://github.com/efangly/smtrack-log) เป็นไอเดียตั้งต้น โดยเลือก stack ดังนี้:

- **TimescaleDB** (PostgreSQL extension) สำหรับเก็บ time-series log — query ร่วมกับข้อมูล relational อื่นผ่าน Prisma/SQL ตัวเดียวกันได้ ไม่ต้องดูแลฐานข้อมูลสองระบบ
- **SSE (Server-Sent Events)** สำหรับ push ข้อมูล real-time ไปยัง frontend — เหมาะกับ one-way stream (server → client), เบา, ทำงานผ่าน HTTP ปกติได้โดยไม่ต้องจัดการ connection upgrade
- **MQTT** สำหรับทั้งการรับข้อมูลจากอุปกรณ์และการกระจายการแจ้งเตือน — ทุกอย่างเดินผ่าน MQTT publish/subscribe เพื่อลด coupling และได้ retry/QoS ของ MQTT มาโดยตรง

**หน้าที่หลักของระบบ**
- Subscribe MQTT topics จากอุปกรณ์ IoT (sensor/device) แบบ real-time เพื่อรับ log/telemetry
- Validate, transform, และบันทึกข้อมูล log/telemetry ลง TimescaleDB (time-series) และ metadata ลง PostgreSQL ปกติผ่าน Prisma
- ประมวลผล/สร้างการแจ้งเตือน (notification) แล้ว publish ผ่าน MQTT topic พร้อมส่งต่อให้ผู้ใช้ผ่าน 2 ช่องทาง: **SSE** (สำหรับ client ที่เปิดหน้าเว็บ/dashboard ค้างอยู่) และ **FCM (Firebase Cloud Messaging)** (สำหรับ push notification ไปยัง mobile app แม้ปิดแอปอยู่)
- เปิด REST API และ SSE endpoint ให้ frontend หรือระบบอื่นดึงข้อมูลย้อนหลังและรับ stream แบบ real-time (log ใหม่, notification ใหม่)
- รองรับคำสั่งย้อนกลับไปยังอุปกรณ์ (command/control ผ่าน MQTT publish)
- งานเสริม: backup/cleanup ข้อมูลเก่าเป็นระยะ, สรุปข้อมูลรายวัน (log-by-day), health check

## Tech Stack

- **Framework:** NestJS (TypeScript)
- **ORM:** Prisma + PostgreSQL พร้อม **TimescaleDB extension** — ใช้ hypertable เก็บ log/telemetry แบบ time-series
- **MQTT Broker Client:** `mqtt` package หรือ NestJS microservices MQTT transport (`@nestjs/microservices`) — ใช้ทั้งฝั่ง ingest log จากอุปกรณ์ และฝั่ง publish notification
- **Real-time push ไปยัง client:** SSE (`@Sse()` decorator + RxJS `Observable`)
- **Mobile push notification:** Firebase Admin SDK (FCM) — ใช้คู่กับ SSE สำหรับ notification, FCM ใช้กรณี client ปิดแอป/ไม่มี connection ค้างอยู่
- **Cache:** Redis
- **Message Queue ภายใน (service-to-service):** RabbitMQ สำหรับ event ระหว่าง microservice ที่ไม่ใช่การสื่อสารกับอุปกรณ์
- **Auth:** JWT + Passport (role-based access control)
- **Validation:** `class-validator` + `class-transformer`
- **Config:** `@nestjs/config` + `.env`
- **Testing:** Jest
- **Package manager:** npm

## โครงสร้างโปรเจค

```
src/
├── main.ts                      # bootstrap, hybrid app (HTTP + MQTT microservice)
├── app.module.ts
├── config/
│   ├── configuration.ts         # โหลด env เป็น typed config
│   └── mqtt.config.ts
├── prisma/
│   ├── prisma.module.ts
│   └── prisma.service.ts        # PrismaClient wrapper (onModuleInit/onModuleDestroy)
├── timescaledb/
│   ├── timescaledb.module.ts
│   └── timescaledb.service.ts   # query hypertable ผ่าน Prisma raw query / query builder
├── mqtt/
│   ├── mqtt.module.ts
│   ├── mqtt-client.service.ts   # publish/subscribe wrapper (ใช้ทั้ง ingest log และ publish notify)
│   └── mqtt.controller.ts       # @MessagePattern/@EventPattern handlers ต่อ topic
├── sse/
│   ├── sse.module.ts
│   ├── sse.service.ts           # broadcast ผ่าน RxJS Subject ไปยัง client ที่ subscribe stream
│   └── sse.controller.ts        # endpoint @Sse() คืน Observable
├── telemetry/
│   ├── telemetry.module.ts
│   ├── telemetry.service.ts     # business logic บันทึก/query ข้อมูล
│   ├── telemetry.controller.ts  # REST endpoints
│   ├── dto/
│   │   ├── create-telemetry.dto.ts
│   │   └── query-telemetry.dto.ts
│   └── entities/
├── logday/                      # สรุปข้อมูลรายวันจาก timescaledb (rollup/aggregate)
├── notification/
│   ├── notification.module.ts
│   ├── notification.service.ts  # สร้าง/บันทึกการแจ้งเตือน แล้ว publish ผ่าน mqtt + push ผ่าน sse และ fcm
│   └── notification.controller.ts
├── fcm/
│   ├── fcm.module.ts
│   └── fcm.service.ts           # wrap Firebase Admin SDK, broadcast push ไปยัง FCM topic ต่ออุปกรณ์ (topic messaging)
├── device/
│   ├── device.module.ts
│   ├── device.service.ts        # จัดการ device registry, auth, status
│   └── device.controller.ts
├── graph/                       # query/aggregate สำหรับ dashboard กราฟ
├── backup/                      # backup/cleanup ข้อมูลเก่าเป็นระยะ (cron)
├── health/                      # health check (`@nestjs/terminus`)
├── mobile/                      # REST endpoints เฉพาะ mobile client (รวมถึง register/unregister fcmToken)
├── redis/                       # cache layer
├── rabbitmq/                    # event bus ภายในระหว่าง microservice (ไม่ใช่การสื่อสารกับอุปกรณ์)
├── consumer/                    # รับ event จาก rabbitmq แล้วส่งต่อ business logic
└── common/
    ├── filters/
    ├── interceptors/
    └── pipes/

prisma/
├── schema.prisma
└── migrations/
```

## MQTT Topic Convention

กำหนด topic pattern ให้ชัดเจนตั้งแต่แรก ครอบคลุมทั้ง telemetry, log และ notification:

```
devices/{deviceId}/telemetry     # อุปกรณ์ส่งข้อมูล sensor ขึ้นมา
devices/{deviceId}/log           # อุปกรณ์ส่ง log เข้ามาเก็บ
devices/{deviceId}/status        # online/offline, heartbeat
devices/{deviceId}/command       # server สั่งงานอุปกรณ์ (publish)
devices/{deviceId}/command/ack   # อุปกรณ์ตอบรับคำสั่ง
notification/{deviceId}          # server publish การแจ้งเตือนที่เกิดขึ้น
```

- ใช้ QoS ให้เหมาะกับความสำคัญของข้อมูล (telemetry/log ทั่วไป QoS 0-1, command และ notification สำคัญ QoS 1-2)
- ตั้ง `retain` เฉพาะ topic สถานะล่าสุด (เช่น status) ไม่ใช้กับ telemetry/log สตรีมต่อเนื่อง
- Payload เป็น JSON เสมอ และควร validate schema ก่อนเข้าสู่ business logic (เช่นด้วย `class-validator` หรือ `zod`)
- เมื่อรับ log ผ่าน MQTT แล้วบันทึกลง TimescaleDB สำเร็จ ให้ยิง event ภายใน (`EventEmitter2`) เพื่อให้โมดูล `sse` push ไปยัง client ที่ subscribe อยู่แบบ real-time ทันที
- เมื่อโมดูล `notification` สร้างการแจ้งเตือนใหม่ ให้ publish ผ่าน MQTT topic (`notification/{deviceId}`) แล้วส่งต่อพร้อมกัน 2 ทาง: push เข้า SSE stream ให้ frontend/dashboard ที่เปิดค้างอยู่ และเรียกโมดูล `fcm` เพื่อ **broadcast** push notification ไปยัง FCM topic ของอุปกรณ์นั้น (`device_{deviceId}`) แบบยิงครั้งเดียว — mobile app เป็นฝั่ง subscribe topic เอง ไม่ใช่ให้ server วนส่งราย `fcmToken`/ราย user

## Prisma Schema

โครงสร้าง model หลักอ้างอิงจาก [schema.prisma ของ smtrack-log](https://github.com/efangly/smtrack-log/blob/main/prisma/schema.prisma) โดยปรับให้ `LogDays` เป็น TimescaleDB hypertable แทนการยิง insert ไป InfluxDB แยกระบบ และเพิ่ม model `NotificationTokens` สำหรับเก็บ FCM token ที่ยังไม่มีในต้นแบบ:

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "linux-musl-openssl-3.0.x"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Devices {
  id           String               @id @default(uuid())
  serial       String               @unique
  ward         String
  hospital     String
  staticName   String
  name         String?
  status       Boolean
  seq          Int
  firmware     String
  remark       String?
  position     String?
  positionPic  String?
  online       Boolean              @default(false)
  log          LogDays[]
  notification Notifications[]
  tokens       NotificationTokens[]
  createAt     DateTime             @default(now())
  updateAt     DateTime             @default(now()) @updatedAt
}

// time-series log จากอุปกรณ์ — แปลงเป็น TimescaleDB hypertable บน sendTime หลัง migrate
// ด้วย SELECT create_hypertable('"LogDays"', 'sendTime', migrate_data => true);
model LogDays {
  id              String   @id @default(uuid())
  serial          String
  temp            Float    @default(0.00)
  tempDisplay     Float    @default(0.00)
  humidity        Float    @default(0.00)
  humidityDisplay Float    @default(0.00)
  sendTime        DateTime @default(now())
  plug            Boolean  @default(false)
  door1           Boolean  @default(false)
  door2           Boolean  @default(false)
  door3           Boolean  @default(false)
  internet        Boolean  @default(false)
  probe           String   @default("1")
  battery         Int      @default(0)
  tempInternal    Float?   @default(0.00)
  extMemory       Boolean  @default(false)
  device          Devices  @relation(fields: [serial], references: [serial])
  createAt        DateTime @default(now())
  updateAt        DateTime @default(now()) @updatedAt

  @@index([serial, sendTime])
}

model Notifications {
  id          String   @id @default(uuid())
  serial      String
  message     String
  detail      String
  status      Boolean  @default(false)
  deliveredSse Boolean @default(false)  // ส่งผ่าน SSE สำเร็จหรือยัง
  deliveredFcm Boolean @default(false)  // ส่งผ่าน FCM สำเร็จหรือยัง
  device      Devices  @relation(fields: [serial], references: [serial])
  createAt    DateTime @default(now())
  updateAt    DateTime @default(now()) @updatedAt

  @@index([serial, createAt])
}

// เก็บ FCM token ของ mobile app ต่ออุปกรณ์/ผู้ใช้ ไม่มีใน smtrack-log ต้นแบบ (ต้นแบบไม่มี push notification)
model NotificationTokens {
  id       String   @id @default(uuid())
  serial   String
  userId   String
  fcmToken String   @unique
  platform String   // ios | android | web
  device   Devices  @relation(fields: [serial], references: [serial])
  createAt DateTime @default(now())
  updateAt DateTime @default(now()) @updatedAt

  @@index([serial])
}
```

- `LogDays` ทำ hypertable บน `sendTime` — query ร่วมกับ metadata ใน `Devices` ได้ใน SQL เดียวผ่าน Prisma โดยไม่ต้องพึ่ง time-series DB แยกระบบ
  - ตั้ง retention policy / continuous aggregate ของ TimescaleDB สำหรับสรุปข้อมูลรายวัน (โมดูล `logday`/`graph`) แทนการเขียน cron aggregate เอง
- `Notifications` เพิ่ม `deliveredSse`/`deliveredFcm` เพื่อ track ว่าส่งแจ้งเตือนออกไปแต่ละช่องทางสำเร็จหรือยัง (ต้นแบบ smtrack-log มีแค่ `status` เดียว)
- `NotificationTokens` เก็บ mapping `fcmToken` ต่อ `serial`/`userId` — โมดูล `mobile` เป็นจุดลงทะเบียน/ลบ token เมื่อ login/logout หรือ token หมดอายุ และเป็นจุดที่ server สั่ง `subscribeToTopic`/`unsubscribeFromTopic` ให้ token นั้นเข้า/ออกจาก FCM topic `device_{serial}` (เพราะ notification ส่งแบบ broadcast ไป topic ไม่ได้ยิงราย token)
- เพิ่ม `@@index` ให้ครบกับ field ที่ใช้ query บ่อย (serial, sendTime/createAt)
- รัน `npx prisma migrate dev` ทุกครั้งที่แก้ schema และ commit ไฟล์ migration เข้า repo เสมอ ห้ามแก้ migration ที่ apply ไปแล้วย้อนหลัง (คำสั่ง `create_hypertable` ให้ต่อท้ายไว้ใน migration SQL หลังจาก Prisma สร้างตารางแล้ว)

## Coding Conventions

- ใช้ DTO + `class-validator` กับทุก input ทั้งจาก MQTT payload และ REST body
- Service layer ห้าม inject `PrismaClient` ตรง ๆ ให้ผ่าน `PrismaService` ที่ extend `PrismaClient` และจัดการ connection lifecycle
- แยก MQTT message handler (`@MessagePattern`/`@EventPattern`) ออกจาก business logic เสมอ — handler ทำหน้าที่รับ/แปลง payload (ทั้ง telemetry, log, notification) แล้วเรียก service เท่านั้น
- การเก็บ log และการแจ้งเตือนไปยังอุปกรณ์/บริการอื่นให้เดินผ่าน MQTT publish เท่านั้น ห้ามใช้ HTTP call (REST client ภายใน/webhook) สำหรับ flow เหล่านี้ เพื่อลด coupling และได้ retry/QoS ของ MQTT มาฟรี
- ใช้ `EventEmitter2` หรือ NestJS internal events เมื่อต้องกระจายข้อมูล telemetry/log/notification ใหม่ไปยังหลาย consumer ภายในโปรเซสเดียวกัน (เช่น โมดูล `sse` สำหรับ push ไปยัง real-time dashboard)
- Real-time ไปยัง client ให้ใช้ SSE เท่านั้น: ใช้ `@Sse()` decorator คืนค่า `Observable<MessageEvent>` ต่อ endpoint (เช่น `GET /telemetry/stream`, `GET /notifications/stream`) โดยภายในโมดูล `sse` ใช้ RxJS `Subject`/`ReplaySubject` รับ event จาก `EventEmitter2` แล้ว multicast ออกไป — ไม่เปิด WebSocket gateway ในโปรเจคนี้
- Notification ต้อง fan-out ผ่าน 2 ช่องทางเสมอเมื่อสร้างเสร็จ: เรียก `sse.service` เพื่อ broadcast ให้ client ที่เปิด stream ค้างอยู่ และเรียก `fcm.service` เพื่อ **broadcast ไป FCM topic `device_{serial}` ครั้งเดียว** (ไม่วนส่งราย `fcmToken`) — สองช่องทางนี้เป็นคนละ concern กัน (SSE = client กำลังเปิดอยู่, FCM = ปลุกแอปที่ปิดอยู่) อย่าเขียนให้ทางใดทางหนึ่งพังแล้วบล็อกอีกทาง (wrap แต่ละ call ด้วย try/catch แยกกัน) แล้วอัปเดต `deliveredSse`/`deliveredFcm` ตามผลจริง
- เพราะ notification ส่งแบบ broadcast ไป topic การส่ง notification จึงไม่ต้องจัดการ token invalid ราย token — การ subscribe/unsubscribe token เข้า/ออก topic และการลบ token ที่ FCM คืน error ตอน `subscribeToTopic` เป็นหน้าที่ของโมดูล `mobile` ตอน register/unregister ไม่ใช่ตอนสร้าง notification
- Error handling: ใช้ custom exception filter จับ error จาก MQTT handler แยกจาก HTTP exception filter (MQTT ไม่มี HTTP response ให้ throw กลับ)
- ตั้งชื่อไฟล์/คลาสตามธรรมเนียม NestJS: `*.module.ts`, `*.service.ts`, `*.controller.ts`, `*.dto.ts`

## Environment Variables (ตัวอย่าง)

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/iot_telemetry   # PostgreSQL + TimescaleDB extension เปิดใช้งานในฐานข้อมูลเดียวกัน
MQTT_BROKER_URL=mqtt://localhost:1883
MQTT_USERNAME=
MQTT_PASSWORD=
MQTT_CLIENT_ID=nestjs-iot-service
MQTT_LOG_TOPIC=devices/+/log
MQTT_NOTIFICATION_TOPIC_PREFIX=notification
REDIS_URL=redis://localhost:6379
RABBITMQ_URL=amqp://user:pass@localhost:5672
JWT_SECRET=
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
PORT=3000
```

## คำสั่งที่ใช้บ่อย

```bash
# Dev server
npm run start:dev

# Prisma
npx prisma generate
npx prisma migrate dev --name <migration_name>
npx prisma studio

# Test
npm run test
npm run test:e2e

# Lint / format
npm run lint
npm run format
```

## แนวทางการทดสอบ

- Unit test: mock `PrismaService` และ MQTT client, เน้นทดสอบ business logic ใน service
- Integration test: ใช้ test database จริง (แยกจาก dev, เปิด TimescaleDB extension ด้วย) รัน migration ก่อนเทส แล้ว teardown หลังเทส
- ทดสอบ MQTT flow (ทั้ง ingest log และ publish notification) ด้วย broker แบบ in-memory/test broker (เช่น Aedes) แทนการต่อ broker จริง
- ทดสอบ SSE endpoint ด้วยการ subscribe `Observable` ที่คืนจาก service โดยตรงในระดับ unit test และยิง HTTP request ค้าง connection ทดสอบใน e2e test
- Unit test โมดูล `fcm`: mock `firebase-admin` (`admin.messaging()`), ห้ามยิง push จริงในเทส และครอบคลุม case: broadcast ไป topic `device_{serial}` ครั้งเดียว (ยืนยันว่าเรียก `send({ topic, ... })` ไม่วนราย token), sanitize ชื่อ topic, ส่งล้มเหลวคืน `sent=false` ไม่ throw, และกรณี Firebase ไม่ init ต้องข้าม

## ข้อควรระวัง

- อย่า commit ค่า MQTT credential หรือ database URL จริงลงไฟล์ ให้ใช้ `.env` และเพิ่มใน `.gitignore`
- Payload จากอุปกรณ์ IoT เชื่อถือไม่ได้ 100% ต้อง validate/sanitize ทุกครั้งก่อนบันทึกลงฐานข้อมูล
- ออกแบบ reconnect/retry logic ให้ MQTT client ให้ดี เพราะ connection กับ broker อาจหลุดได้บ่อยในระบบ IoT จริง — สำคัญเป็นพิเศษเพราะทั้ง log ingestion และ notification พึ่งพา MQTT เพียงช่องทางเดียว ไม่มี HTTP เป็นทางสำรอง
- พิจารณา rate limiting หรือ batching การ insert หากอุปกรณ์ส่งข้อมูลความถี่สูงมาก เพื่อไม่ให้ TimescaleDB รับภาระเกิน (ใช้ chunk interval ของ hypertable ให้เหมาะสมกับ throughput)
- SSE connection ค้างไว้นาน (long-lived HTTP connection) ต้องระวัง reverse proxy/load balancer timeout — ตั้งค่า `X-Accel-Buffering: no` (Nginx) และ heartbeat/keep-alive event เป็นระยะเพื่อกันหลุด
- ตั้ง retention policy บน TimescaleDB hypertable ให้ชัดเจน (ร่วมกับโมดูล `backup`) เพื่อไม่ให้ดิสก์เต็มจากข้อมูล log ความถี่สูง

---

> **หมายเหตุ:** ไฟล์นี้เป็น template เริ่มต้น ควรปรับรายละเอียด (ชื่อ topic, schema, tech stack ย่อย) ให้ตรงกับความต้องการจริงของโปรเจคก่อนใช้งาน
