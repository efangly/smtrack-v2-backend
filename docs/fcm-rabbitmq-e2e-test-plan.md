# แผนทดสอบ e2e: FCM push ผ่าน RabbitMQ (publisher only)

**สถานะ:** แผน — ยังไม่ implement โค้ดทดสอบ
**ที่มา:** refactor ย้าย FCM push notification จากการเรียก Firebase Admin SDK ตรง ๆ (`fcm` module, ลบออกแล้ว) ไปเป็น publish message เข้า RabbitMQ (`RabbitmqService.emit()` ผ่าน `ClientProxy`) ให้ FCM service แยกต่างหาก (นอกโปรเจคนี้) เป็นคน consume แล้วยิง push จริง
**ขอบเขต:** โปรเจคนี้ทำหน้าที่ **producer เท่านั้น** — ไม่ครอบคลุม flow subscribe/unsubscribe token เข้า/ออก FCM topic (ยังไม่ implement ในโค้ด ไม่อยู่ใน scope งานนี้)

## สรุป design ที่เกี่ยวข้อง

| อะไร | ค่า |
|---|---|
| Queue | `RABBITMQ_FCM_QUEUE` (default `fcm_notification_queue`) |
| Message pattern | `fcm-push` (`FCM_PUSH_PATTERN` ใน `src/config/rabbitmq.config.ts`) |
| Payload | `{ serial, notification: { title, body }, data: { serial, notificationId, probe?, probeId? } }` |
| Connection lifecycle | `ClientProxy` สร้างตอน `RabbitmqService.onModuleInit`, ปิดตอน `onModuleDestroy` |
| Semantics ของ `deliveredFcm` | `true` เมื่อ `RabbitmqService.emit()` resolve (broker รับ publish แล้ว จริง ๆ คือ `ClientProxy.emit()` observable resolve) — ไม่ใช่การยืนยันว่า FCM ส่งถึงมือถือจริง |
| Error handling | publish ล้มเหลว (broker ต่อไม่ได้/timeout) → catch ใน `deliverFcm()`, ไม่บล็อก request, `deliveredFcm=false` |

## 1. Unit-level (มีอยู่แล้ว — cover ไว้เป็น baseline)

- `src/notification/notification.service.spec.ts` — mock `RabbitmqService.emit`, ครอบคลุม: publish สำเร็จ, publish reject, MQTT/SSE ล้มไม่บล็อก FCM leg, payload shape (`serial`/`notification`/`data`, probe ติดไปแค่ตอนมี)
- ยังไม่มี unit test ของ `RabbitmqService` เอง (ตอนนี้ logic บางเช่น connect/close/emit เป็น thin wrapper รอบ `ClientProxy` — พิจารณาเพิ่ม spec แยกถ้า logic ซับซ้อนขึ้นในอนาคต เช่น retry/backoff)

## 2. e2e ผ่าน mock (`test/notification.e2e-spec.ts` — มีอยู่แล้ว, ปรับตามนี้)

ทุกเคสรันผ่าน `createTestApp()` ที่ override `RabbitmqService` ด้วย mock (`mocks.rabbitmq.emit`) — ไม่ต่อ broker จริง เหมาะกับ CI ทั่วไป

- [x] `POST /notifications` → `deliveredSse=true`, `deliveredFcm=true` เมื่อ mock resolve ปกติ, ค่า persist ตรงกับ DB
- [x] `mocks.rabbitmq.emit` ถูกเรียกครั้งเดียวด้วย pattern `'fcm-push'` และ payload ที่มี `serial`, `notification: {title, body}`, `data.serial`
- [x] publish reject (`mockRejectedValueOnce`) → response ยังคืน 201, `deliveredFcm=false`, `deliveredSse=true` (SSE ไม่ถูกบล็อก)
- [x] notification ที่มี `probe`/`probeId` → payload `data` มี `probe`/`probeId`; ไม่มี → ไม่มี key เหล่านี้ใน `data` เลย (`test/notification.e2e-spec.ts`)
- [x] ยิง `POST /notifications` สองครั้งติดกันด้วย serial ต่างกัน → `mocks.rabbitmq.emit` ถูกเรียกแยก 2 ครั้ง แต่ละครั้ง payload มี `serial` ที่ถูกต้อง (`test/notification.e2e-spec.ts`)

## 3. e2e ผ่าน broker จริง (ของใหม่ — ต้องเพิ่ม)

ต่างจาก `test/rmq-consumer.e2e-spec.ts` (ทดสอบฝั่ง **consume** จาก legacy) — ชุดนี้ทดสอบฝั่ง **produce** ของ flow ใหม่ ต้องพิสูจน์ว่า message ที่ backend publish จริง ๆ ไปโผล่ที่ queue ปลายทางถูกต้อง โดยไม่ต้องพึ่ง FCM service ตัวจริง (อยู่นอกโปรเจค)

**แนวทาง:** สร้างไฟล์ `test/rmq-fcm-publish.e2e-spec.ts` ทำนองเดียวกับ `rmq-consumer.e2e-spec.ts` แต่กลับด้าน — โปรเจคนี้เป็น producer, เทสเปิด consumer ชั่วคราวฝั่งตัวเองเพื่อดักอ่าน queue

ประเด็นสำคัญที่ต้องระวัง (เรียนรู้จาก `rmq-consumer.e2e-spec.ts` เดิม):
- ห้ามใช้ queue จริง (`fcm_notification_queue`) — ต้อง override `RABBITMQ_FCM_QUEUE` เป็นชื่อเฉพาะเทส (เช่น `fcm_notification_queue_e2e`) ก่อนเรียก `createTestApp()` เพราะ `configuration.ts` อ่าน `process.env` ตอน `ConfigModule` init
- **ห้าม override `RabbitmqService`** ในเทสชุดนี้ (ต่างจากชุด mock อื่น) — ต้องปล่อยให้มันต่อ broker จริงเพื่อทดสอบของจริง
- ลบ queue ทิ้งใน `afterAll` กัน queue ค้างสะสมบน broker ที่ใช้ร่วมกัน
- ต้องมี `RABBITMQ_URL` ชี้ broker ที่เข้าถึงได้ตอนรัน e2e (เหมือนที่ `rmq-consumer.e2e-spec.ts` ต้องการอยู่แล้ว — ชุดนี้ไม่เพิ่ม dependency ใหม่)

Test cases (`test/rmq-fcm-publish.e2e-spec.ts` — implement แล้ว, รันผ่านจริงกับ broker ใน `.env`):

- [x] `POST /notifications` (ผ่าน HTTP จริง, ไม่ mock RabbitmqService — `createTestApp({ realRabbitmq: true })`) → consumer จำลอง (Nest microservice แยก process ในตัวเทส, `@EventPattern(FCM_PUSH_PATTERN)`) ได้รับ message ภายในเวลาที่กำหนด (`waitFor`)
- [x] payload ที่รับได้ตรงกับที่ backend ส่ง: `serial` ตรงกับ request, `notification.title`/`notification.body` ตรงกับ `message`/`detail`, `data.notificationId` ตรงกับ id ที่สร้างจริงใน DB
- [x] publish สำเร็จจริง (ไม่ใช่แค่ HTTP 201) — ตรวจว่า `deliveredFcm=true` ใน response **และ** message ไปถึง queue จริง ยืนยันคู่กันในเคสเดียว
- [ ] **ยังไม่ implement:** broker ไม่พร้อมใช้งาน (จำลองด้วยการสลับ `RABBITMQ_URL` เป็น host ที่ต่อไม่ได้ชั่วคราว) → `POST /notifications` ยังคืน 201, `deliveredFcm=false`, ไม่ throw 5xx — ยากที่จะจำลองแบบไม่กระทบ suite อื่นที่แชร์ broker/connection เดียวกันตอนรันขนาน (`maxWorkers: 1` ช่วยได้บางส่วนแต่ยังกระทบ `RabbitmqService` ตัวเดียวกันของ process นั้นทั้งหมด) ต้องออกแบบเพิ่มก่อนค่อย implement เช่นแยก `ClientProxy` ปลอมที่ reject เฉพาะเทสนี้แทนการสลับ env จริง

## 4. Integration ระดับ config/wiring

- [x] `RabbitmqService.onModuleInit()` เรียก `ClientProxy.connect()` จริงเมื่อ app boot — ยืนยันทางอ้อมผ่านเคสข้อ 3 ที่ publish สำเร็จจริง (ถ้า connect ไม่ทำงาน publish จะ fail หมด)
- [x] `RabbitmqService.onModuleDestroy()` เรียก `ClientProxy.close()` เมื่อ `app.close()` — เรียกจริงตาม lifecycle, แต่สังเกตว่า `npm run test:e2e` ทั้งชุด (รวม `rmq-consumer.e2e-spec.ts` เดิม) มี warning `Jest did not exit one second after test run` อยู่ก่อนแล้ว (ไม่ใช่ regression ใหม่จากงานนี้) — ยังไม่ไล่ root cause ว่าเป็น handle ของ RMQ ตัวไหนค้าง ถ้าจะแก้ควรทำแยกเป็นงาน cleanup ต่างหาก ไม่ปนกับงานนี้
- [x] `.env.example` / `.env.docker.example` มี `RABBITMQ_FCM_QUEUE` ครบ และ `configuration.ts` fallback เป็น `fcm_notification_queue` ถูกต้องเมื่อไม่ตั้ง env (`src/config/configuration.spec.ts`)

## 5. Regression ที่ต้องเช็คว่าไม่พัง

- [x] `test/rmq-consumer.e2e-spec.ts` (ฝั่ง consume `device-log`/`device-notification` จาก legacy) รันแล้วไม่พังจาก publish leg ใหม่ — ผ่าน `createTestApp()` ที่ mock `RabbitmqService` อยู่แล้ว ยืนยันว่าทั้งสองชุด (`rmq-consumer` mock publish / `rmq-fcm-publish` real publish) รันร่วมกันได้โดยไม่แย่ง queue กัน (คนละ queue name)
  - **พบ pre-existing failure ที่ไม่เกี่ยวกับงานนี้:** เคส `device-log จาก RabbitMQ จริงถูกเขียนลง LogDays` fail เพราะ timezone offset (`sendTime` ถูกตีความผิดเป็น local time ของเครื่องที่รันเทสแทน UTC) — เกิดก่อนงานนี้แล้ว ไม่ใช่ regression จากการย้าย FCM ไป RabbitMQ ไม่ได้แก้ในรอบนี้เพราะนอกขอบเขต
- [x] path อื่นที่เคย fan-out ผ่าน `NotificationService.create()` (เช่น `device-notification` consumer, MQTT ingest) ยัง trigger `deliverFcm()` เหมือนเดิม — ยืนยันจาก `test/rmq-consumer.e2e-spec.ts` (`device-notification` เคสที่สอง ผ่าน) เพราะเปลี่ยนแค่ transport ปลายทาง ไม่เปลี่ยน call site
- **พบ pre-existing failure อีกจุดหนึ่ง ไม่เกี่ยวกับงานนี้เช่นกัน:** `test/device-repair.e2e-spec.ts` เคส `PUT /repairs/:id ... ตัด serial ที่ส่งมาแปลกปลอมทิ้ง` ได้ 400 แทนที่จะเป็น 200 — ไม่แตะโมดูล `device-repair` ในงานนี้เลย ควรแยกไป track เป็นบั๊กต่างหาก

## หมายเหตุ

- อัปเดต `CLAUDE.md` แล้วให้สะท้อนสถาปัตยกรรมใหม่ (publish ผ่าน RabbitMQ แทนเรียก Firebase Admin SDK ตรง ๆ, ไม่มี `fcm` module/`firebase-admin` แล้ว, ตัด `NotificationTokens` model ที่จริง ๆ ถูกลบออกจาก schema ไปนานแล้วออกจากเอกสารด้วย)
- ยังมี pre-existing test failure 2 จุดที่ไม่เกี่ยวกับงานนี้ (ดูหัวข้อ 5) — แนะนำเปิด issue แยกติดตาม ไม่ block การ merge งาน FCM/RabbitMQ นี้
