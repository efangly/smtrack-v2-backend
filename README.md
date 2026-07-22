# SMtrack v2 Backend

NestJS backend สำหรับระบบ IoT Telemetry/Log + Notification (MQTT → TimescaleDB → SSE/FCM)
รายละเอียดสถาปัตยกรรมทั้งหมดดูที่ [`CLAUDE.md`](./CLAUDE.md)

## รอบนี้ทำอะไรไปแล้ว (Core Vertical Slice)

**Flow หลักที่ทำงานจริงครบวงจร:**

1. **Log ingestion** — `MqttController` (`devices/+/log`) → `TelemetryService.ingest()` → บันทึก `LogDays` (TimescaleDB) → emit `telemetry.created` → `SseService` push ให้ client ที่เปิด `/telemetry/stream`
2. **Notification fan-out** — `NotificationService.create()` → บันทึก `Notifications` → publish MQTT (`notification/{serial}`) → fan-out พร้อมกัน 2 ทาง (`SseService` + `FcmService`) ด้วย try/catch แยกกัน → อัปเดต `deliveredSse`/`deliveredFcm` ตามผลจริง

> **FCM = broadcast แบบ topic** — `FcmService` ยิงไป FCM topic `device_{serial}` ครั้งเดียว
> (ไม่วนส่งราย token/ราย user) mobile client เป็นฝั่ง subscribe topic เอง (`subscribeToTopic`)

**โมดูลที่ implement จริง:** `prisma`, `sse`, `telemetry`, `mqtt`, `fcm`, `notification`, `device`, `mobile`
**โมดูล scaffold (ยังไม่ลง logic เต็ม):** `logday`, `graph`, `backup`, `health`, `redis`, `rabbitmq`, `consumer`

> หมายเหตุ: ยังไม่ทำ auth (JWT/Passport) และ docker-compose ในรอบนี้

## Setup

```bash
npm install
cp .env.example .env          # แก้ค่าให้ตรง infra จริง (Postgres+TimescaleDB, MQTT, Redis, RabbitMQ, Firebase)
npx prisma generate           # จำเป็นต้องรันก่อน build เสมอ (client v7 ถูก gitignore ไว้)
npx prisma migrate deploy     # apply migration ที่มี create_hypertable แล้ว (ต้องมี TimescaleDB extension)
npm run start:dev
```

> Migration `20260715000000_init` มีคำสั่ง `CREATE EXTENSION timescaledb` + เปลี่ยน PK ของ `LogDays`
> เป็น composite `(id, sendTime)` + `create_hypertable(...)` — จำเป็นต้องมี TimescaleDB ติดตั้งใน PostgreSQL

### Prisma 7 (Rust-free + driver adapter)

โปรเจคใช้ **Prisma ORM v7** — มีจุดต่างจาก v6 ที่ควรรู้:

- ใช้ generator `prisma-client` (`moduleFormat = "cjs"`) generate client ลง `src/generated/prisma`
  (ไม่ใช่ `node_modules/@prisma/client` แบบเดิม) — dir นี้ถูก gitignore ต้องรัน `prisma generate` เอง
- import จาก path ที่ generate: `import { PrismaClient } from '../generated/prisma/client'`
- Rust-free — ต่อ DB ผ่าน **driver adapter** `@prisma/adapter-pg` (`PrismaPg`) ใน `PrismaService`
- `DATABASE_URL` ย้ายจาก `datasource` block ไปที่ `prisma.config.ts` (โหลด env ด้วย `dotenv`);
  runtime อ่านผ่าน `ConfigService` → adapter connectionString

## Endpoints (สรุป)

| Method | Path | คำอธิบาย |
| --- | --- | --- |
| `GET` | `/telemetry?serial=&from=&to=&limit=` | query log ย้อนหลัง |
| `GET` | `/telemetry/stream` | SSE stream log ใหม่ (real-time) |
| `POST` | `/notifications` | สร้างการแจ้งเตือน + fan-out |
| `GET` | `/notifications/:serial` | ประวัติการแจ้งเตือน |
| `GET` | `/notifications/stream` | SSE stream notification ใหม่ |
| `POST` `GET` | `/devices` `/devices/:serial` | device registry |
| `POST` `DELETE` | `/mobile/tokens` `/mobile/tokens/:fcmToken` | ลงทะเบียน/ลบ FCM token |
| `GET` | `/health` | health check (Prisma ping) |
| `GET` | `/logday/:serial` `/graph/:serial` | สรุปรายวัน / กราฟ (scaffold) |

## รันสภาพแวดล้อมทดสอบเต็มรูปแบบ (Docker Compose)

ยก app + dependencies + observability stack ขึ้นทั้งชุดในเครื่อง ไม่แตะ server/ข้อมูลจริง:

```bash
npm run docker:up      # build + start ทั้งหมด (migration + seed รันให้อัตโนมัติ)
npm run docker:logs    # ดู log ของ app
npm run docker:clean   # ปิดและลบ volume ทิ้ง
```

| UI | URL |
| --- | --- |
| **Grafana** (จุดเริ่มต้น) | http://localhost:3001 — เข้าได้เลยไม่ต้อง login |
| app | http://localhost:3000 |
| Prometheus | http://localhost:9090 |
| Tempo | http://localhost:3200 |
| RabbitMQ management | http://localhost:15672 (guest/guest) |

> Grafana map ออกมาที่ **3001** เพราะ 3000 ชนกับตัว app

### สถาปัตยกรรม observability

```
app ──OTLP/HTTP:4318──> otel-collector ──┬──> Tempo       (traces)
  │                                      └──> Prometheus  (metrics)
  └── stdout JSON log ──> Alloy ─────────────> Loki        (logs)
                                    Grafana ──┘ (correlate ทั้ง 3)
```

log **ไม่** เดินผ่าน OTLP — `logger.config.ts` พ่น JSON ออก stdout เมื่อ `NODE_ENV=production`
แล้วให้ Alloy เก็บจาก Docker log driver ส่งเข้า Loki พร้อมดึง `trace_id`/`span_id`
ออกมาเป็น structured metadata ซึ่งเป็นตัวที่ทำให้กระโดดจาก log ไป trace ได้

### ทดสอบว่า OTel ทำงานจริง

```bash
# 1. HTTP trace
curl -s localhost:3000/health

# 2. MQTT ingest — เส้นทางหลักของระบบ (DEV-001 มาจาก seed)
docker compose exec -T mosquitto mosquitto_pub -h localhost -t 'devices/DEV-001/log' \
  -m '{"temp":25.5,"humidity":60,"sendTime":"2026-07-19T11:00:00.000Z","plug":true,"battery":95}'

# 3. SSE
curl -N localhost:3000/telemetry/stream
```

จากนั้นเปิด Grafana → Explore:

- **Tempo** → Search service `smtrack-backend` → ต้องเห็น trace ที่ root เป็น
  `mqtt.consume devices/DEV-001/log` → `telemetry.ingest` → `pg.query:INSERT` → Redis `scan`
- **Loki** → `{service_name="smtrack-backend"}` → บรรทัด log ของ `TelemetryService`
  จะมีปุ่ม **"ดู trace ใน Tempo"** กดแล้วเปิด trace ตัวเดียวกัน
- **Prometheus** → `smtrack_mqtt_messages_total` (มี label topic/status),
  `smtrack_sse_active_connections`, `smtrack_telemetry_ingest_duration_milliseconds_bucket`
  (suffix `_milliseconds` มาจาก unit ของ OTel ที่ Prometheus เติมให้เอง)

> metric ใช้เวลาถึง 30 วินาทีกว่าจะโผล่ (`exportIntervalMillis` ใน `tracing.ts`)

## คำสั่งที่ใช้บ่อย

```bash
npm run start:dev      # dev server (HTTP + MQTT microservice)
npm run build          # tsc build
npm run lint           # eslint --fix
npm test               # unit tests
npm run test:cov       # coverage
```

## Tests

Unit test ครอบคลุมโมดูลหลัก (19 tests):

- `telemetry.service` — บันทึก log + emit event, แปลง sendTime, ประกอบ query
- `notification.service` — fan-out ครบ, SSE พัง/FCM พังไม่บล็อกกัน, delivered flags, MQTT พังไม่บล็อก
- `fcm.service` — ส่งสำเร็จ, token invalid ลบ record ไม่ retry, error อื่นไม่ลบ
- `sse.service` — filter ตาม channel, event handler broadcast ถูก channel
- `mqtt.controller` — handler เรียก service, เติม serial จาก topic (แยก handler จาก logic)
