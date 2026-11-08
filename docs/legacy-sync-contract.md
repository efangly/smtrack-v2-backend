# Legacy sync contract (ระบบเดิม → SMtrack v2)

สัญญาระหว่างระบบเดิม (smtrack-device / smtrack-log) ซึ่งเป็นฝั่ง **publish** กับ v2 ซึ่งเป็นฝั่ง **consume**
ใช้ช่วงรันคู่ขนานก่อน cutover เท่านั้น เหตุผลของการออกแบบอยู่ใน [ADR-0007](./adr/0007-legacy-sync-one-way-via-rabbitmq-snapshots.md)
และคำศัพท์อยู่ใน `CONTEXT.md` (Legacy sync, Backfill, Cutover, Reconciliation)

- ทิศทางเดียว: ระบบเดิม → v2 เท่านั้น v2 ไม่ส่งอะไรกลับ
- ช่องทางเดียว: RabbitMQ ของ v2 ระบบเดิมไม่ต้องรู้จัก DB ของ v2 และ v2 ไม่อ่าน DB ของระบบเดิมเพื่อ sync
  (อ่านแบบ read-only ได้เฉพาะงาน backfill และ reconciliation)

## 1. Broker และ exchange

| | ค่า |
|---|---|
| Broker | RabbitMQ ของ v2 (`RABBITMQ_URL` ฝั่ง v2 — ขอ user แยกที่มีสิทธิ์ publish เข้า exchange นี้เท่านั้น) |
| Exchange | `legacy.sync` (type `topic`, durable) |
| Routing key | เท่ากับ `pattern` ของ message (เช่น `legacy.device.upserted`, `device-log`) |
| Delivery | `persistent: true` (deliveryMode 2) และแนะนำให้ใช้ publisher confirms |

⚠️ **ห้าม** publish เข้า queue ของ v2 ตรง ๆ และ **ห้าม** consume จาก queue ใดของ v2
ถ้าสอง consumer อ่าน queue เดียวกัน RabbitMQ จะแบ่ง message กัน แต่ละฝั่งจะได้ไปแค่บางส่วน

ฝั่ง v2 bind queue `legacy_sync_queue` เข้ากับ exchange ด้วย routing key `#` แล้วถ้า v2 ประมวลผลไม่ได้
message จะถูก dead-letter เข้า `legacy_sync_dlq` เพื่อรอตรวจหรือ replay

## 2. Envelope

body เป็น JSON ตามรูปแบบของ NestJS RMQ transport:

```json
{ "pattern": "legacy.device.upserted", "data": { ...แถวของระบบเดิม... } }
```

ถ้าระบบเดิมเป็น NestJS ให้ใช้ `ClientProxy.emit(pattern, data)` กับ client ที่ตั้ง `exchange: 'legacy.sync'`
และ `exchangeType: 'topic'` ซึ่ง Nest จะประกอบ envelope ให้เอง
ส่วนวันที่ทุก field ให้ส่งเป็น ISO-8601 string

## 3. Runtime events (ใช้ payload เดิมของ v2)

| pattern | data | ไปที่ |
|---|---|---|
| `device-log` | `CreateTelemetryDto` — ต้องมี `serial` และ **`sendTime`** (เวลาที่กล่องวัด ไม่ใช่เวลาที่ส่ง) | `TelemetryService.ingest()` |
| `device-notification` | payload ของ `NotificationConsumerController` | `NotificationService.create()` |
| `device-online` / `device-offline` | `{ "serial": "..." }` | `DeviceService.setOnline()` |

`device-log` เป็น idempotent ตาม `(serial, probe, sendTime)` การส่งซ้ำจึงไม่ทำให้เกิดแถวซ้ำ ถ้าไม่ส่ง `sendTime` v2 จะใช้เวลาที่รับแทน
ซึ่งทำให้กันซ้ำไม่ได้และเวลาก็ผิดด้วย

## 4. Metadata snapshots

ทุกครั้งที่แถวถูกสร้างหรือแก้ไข ให้ส่ง **ทั้งแถวตาม schema ของระบบเดิม** (เช่น `SELECT *` หลัง commit) ไม่ใช่เฉพาะ field ที่เปลี่ยน

| pattern | ตารางระบบเดิม | PK (`legacyId`) | field ที่ v2 ใช้อ้างอิง |
|---|---|---|---|
| `legacy.device.upserted` | `Devices` | `deviceId` | `id` (= serial ของกล่อง), `staticName`, `hospital` (= tenantId), `ward` (= departmentId) |
| `legacy.probe.upserted` | `Probes` | `id` | `sn` (serial), `channel` |
| `legacy.config.upserted` | `Configs` | `id` | `sn` (serial) |
| `legacy.repair.upserted` | `Repairs` | `id` | `seq`, `devName` (= staticName) |
| `legacy.warranty.upserted` | `Warranties` | `id` | `devName` (= staticName) |

field ทั้งหมดที่รับอยู่ใน `src/legacy-sync/dto/legacy-snapshot.dto.ts` ถ้าส่ง field ที่ไม่ได้ประกาศไว้ v2 จะตัดทิ้งเงียบ ๆ
ถ้าขาด field ที่บังคับหรือชนิดข้อมูลผิด message จะเข้า DLQ

**ต้องมี `createAt` และ `updateAt` เสมอ** — v2 ตัดสินแบบ last-writer-wins ด้วย `updateAt`
snapshot ที่ `updateAt` ไม่ใหม่กว่าแถวที่ apply ไปแล้วจะถูกข้าม การส่งซ้ำหรือส่งสลับลำดับจึงไม่เป็นปัญหา
ถ้าแก้แถวแล้ว `updateAt` ไม่ขยับ v2 จะไม่เห็นการแก้นั้น

### การลบ

| pattern | data |
|---|---|
| `legacy.device.deleted` | `{ "deviceId": "<PK>", "id": "<serial>", "updateAt": "<เวลาที่ลบ>" }` |
| `legacy.probe.deleted` / `legacy.config.deleted` / `legacy.repair.deleted` / `legacy.warranty.deleted` | `{ "id": "<PK>", "updateAt": "<เวลาที่ลบ>" }` |

ผลฝั่ง v2:
- **device**: ไม่ลบจุดติดตั้ง (log อ้างถึงอยู่) แต่ปิด assignment ของกล่อง ล้าง serial และตั้ง `status=false`
  ถ้าจุดนั้นมีกล่องอื่นติดอยู่แล้ว (ถูก Swap ไปก่อน) จะไม่ทำอะไรกับจุดติดตั้ง
- **probe**: ลบจริง โดย log ยังอยู่ครบ (`probe_id` ถูกตั้งเป็น NULL และยังมี channel ดิบเก็บไว้)
- **config / repair / warranty**: ลบจริง

แถวที่ลบไปแล้วจะไม่ถูกสร้างกลับ ถึงมี snapshot ของ PK เดิมมาทีหลังก็จะถูกข้าม

### การเปลี่ยนกล่อง (Swap)

เวลาเปลี่ยนกล่องเสียที่จุดเดิม ระบบเดิมสร้างแถว `Devices` ใหม่ที่มี serial ใหม่ และใช้ **`staticName` เดิม**
เมื่อ v2 ได้รับ snapshot ของแถวใหม่ จะหาจุดติดตั้งจาก `staticName` แล้วทำ Swap (ปิด assignment ของกล่องเก่า
แล้วเปิดของกล่องใหม่) และจะข้าม snapshot ของแถวเก่าที่มาทีหลังทั้งหมด

ลำดับที่แนะนำ: ส่ง `legacy.device.upserted` ของแถวใหม่ก่อน แล้วค่อยส่ง probe และ config ของ serial ใหม่ ถ้าลำดับสลับกัน
probe จะยังหาจุดติดตั้งไม่เจอและเข้า DLQ ต้อง replay ทีหลัง

## 5. ลำดับการเริ่ม sync

1. **สร้าง queue โดยยังไม่ consume**: ฝั่ง v2 รัน `npm run legacy-sync:setup` (สร้าง exchange, queue, DLQ และ binding)
2. **ระบบเดิมเริ่ม publish** เข้า `legacy.sync` ซึ่ง message จะค้างรอใน queue
3. **Backfill metadata**: `SOURCE_DATABASE_URL=<read-only> node dist/cli/legacy-backfill` (รันซ้ำได้)
4. **Backfill LogDays**: copy ด้วย SQL ตาม `scripts/migrate-legacy/README.md` โดย unique index กันแถวซ้ำกับช่วงที่ sync มาแล้ว
5. **เปิด consume**: ตั้ง `LEGACY_SYNC_ENABLED=true` แล้ว restart เพื่อให้ v2 ดูด message ที่ค้างอยู่
6. **Reconciliation** รายวันจนถึง cutover (ดู §6)

## 6. การตรวจความครบถ้วน

- **DLQ**: `legacy_sync_dlq` ต้องว่างเสมอ ถ้ามี message แปลว่ามีข้อมูลที่ยังไม่เข้า v2 ต้องแก้สาเหตุแล้ว replay (shovel กลับเข้า exchange)
- **Queue depth** ของ `legacy_sync_queue` ควรอยู่ใกล้ 0 ถ้าค้างลึก แปลว่า v2 consume ไม่ทัน หรือ consumer ไม่ได้เปิดอยู่
- **Reconciliation** (`node dist/cli/legacy-reconcile`): เทียบจำนวน log ราย serial ต่อวัน และ `updateAt` ล่าสุดของแต่ละตาราง
  ถ้าไม่ตรงจะ exit 1 (ใช้ alert ของ CronJob ที่ Failed เหมือนงาน archive)
- เกณฑ์ก่อน cutover: reconciliation ไม่มี mismatch 3 วันติดต่อกัน

## 7. Cutover และสิ้นสุด sync

cutover ทำครั้งเดียวสำหรับทุก tenant
1. ชี้กล่องและแอปทั้งหมดมาที่ v2
2. รอ `legacy_sync_queue` ว่าง แล้วรัน reconciliation รอบสุดท้าย
3. หยุดระบบเดิม แล้วตั้ง `LEGACY_SYNC_ENABLED=false`
4. ลบ exchange, queue และ DLQ ออก จากนั้นลบโมดูล `src/legacy-sync/`, CLI `legacy-backfill`/`legacy-reconcile` และตาราง `legacy_sync_map` ใน PR ถัดไป

## นอกขอบเขตของสัญญานี้

- **Firmwares**: ไฟล์ firmware ไม่ได้ส่งผ่าน queue ให้ใช้ `npm run migrate:firmware` ซ้ำก่อน cutover
- **รูป `positionPic`**: sync ไปแค่ URL เดิม ส่วนไฟล์จะ copy ทีเดียวตอน cutover
- **Audit / partner key**: ไม่ sync
