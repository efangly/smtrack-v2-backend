# แผนปรับปรุง Observability Stack (Otel-Collector / Tempo / Loki / Prometheus / Grafana)

> เอกสารนี้สรุปผลการทดสอบ observability stack ในเครื่อง dev (backend รันบน host port 3000, stack รันผ่าน Docker) พร้อมปัญหาที่พบและแผนงานที่เหลือ ให้ session อื่นนำไปทำต่อได้โดยไม่ต้องย้อนกลับไปสืบใหม่ทั้งหมด

## สถานะปัจจุบัน (ทดสอบผ่านแล้ว)

ทดสอบ pipeline แบบ end-to-end กับ backend จริงที่รันบน host `:3000` (เชื่อมต่อ DB/MQTT/Redis จริงที่ `siamatic.thddns.net`) แล้วยืนยันว่าใช้งานได้จริง:

- **Traces**: backend → otel-collector (OTLP HTTP `:4318`) → Tempo — เห็น span จริงครบ (`GET /log/devices`, `device_online_queue process`, `pg.query:*`, `tcp.connect`, `dns.lookup` ฯลฯ)
- **Metrics**: backend → otel-collector → Prometheus (OTLP receiver) — เห็นทั้ง custom metric ของแอป (`smtrack_mqtt_messages_total`, `smtrack_rmq_messages_total`, `smtrack_notification_delivery_total`, `smtrack_telemetry_ingest_duration_milliseconds_*`) และ auto-instrumentation metric (`http_server_duration_milliseconds_*`, `db_client_operation_duration_seconds_*`, `nodejs_eventloop_*`, `v8js_memory_*`)
- **Service Graph / Span Metrics**: Tempo metrics-generator → Prometheus remote_write — เห็น `traces_service_graph_request_total`, `traces_spanmetrics_calls_total`, `traces_spanmetrics_latency_*` จริง
- **Grafana**: ทั้ง 3 datasource (Tempo/Loki/Prometheus) query ได้จริงผ่าน Grafana proxy, สร้าง dashboard 2 อันไว้แล้ว (ภาษาไทย):
  - `docker/grafana/provisioning/dashboards/smtrack-backend-overview.json` (uid `smtrack-backend-overview`)
  - `docker/grafana/provisioning/dashboards/smtrack-backend-traces.json` (uid `smtrack-backend-traces`)
- **Log pipeline (Alloy → Loki)**: ทดสอบผ่านแล้ว end-to-end โดยรัน backend เป็น container จริง (`docker-compose.yml` เต็มสตริง `app` service, target `runner`) บน network เดียวกับ `alloy` — ดูรายละเอียดผลทดสอบในหัวข้อ "อัปเดตล่าสุด" ด้านล่าง

## อัปเดตล่าสุด (แก้ครบ 4 ใน 5 ข้อค้าง — เหลือแค่ alerting rules)

Session นี้แก้และทดสอบ end-to-end จริงครบทั้ง 4 ข้อที่เคยค้างไว้ (ไม่รวม alerting rules ซึ่งยังไม่ได้ทำตามที่ตกลงกันไว้):

1. **แก้บั๊ก `tracing.ts` env-loading-order** — เพิ่ม `import 'dotenv/config'` เป็นบรรทัดแรกสุดของ `src/main.ts` (ก่อน `import './observability/tracing'`) และย้าย `dotenv` จาก `devDependencies` เป็น `dependencies` ใน `package.json` ยืนยันแล้วว่า `npm run build` ผ่าน และตอนรันจริงใน container เห็น trace ส่งเข้า otel-collector/Tempo ปกติ (พิสูจน์ว่า SDK start สำเร็จ)
2. **สร้าง `docker/mosquitto/mosquitto.conf`** — ไฟล์ใหม่ (`listener 1883`, `allow_anonymous true`, `persistence false`, `log_dest stdout`) ให้ตรงกับที่ `app` service ต่อแบบไม่ auth และ healthcheck ของ mosquitto ใช้แบบไม่ auth เช่นกัน
3. **ทดสอบ log pipeline (Alloy → Loki) แบบ end-to-end** — ผ่านแล้ว รายละเอียดผลทดสอบอยู่ท้ายหัวข้อนี้
4. **อัปเกรด Tempo เป็น 2.8.1 แก้ TraceQL search panel** — ผ่านแล้ว ยืนยันผ่าน Grafana Explore UI จริง (ไม่ใช่แค่ curl API) เห็น "Streaming: Enabled" และได้ trace list กลับมาปกติ ไม่เจอ error `backend TraceQL search queries are not supported` อีก

**ระหว่างทางเจอปัญหาเพิ่มเติมที่ไม่ได้ระบุไว้ในเอกสารรอบก่อน (แก้ไปด้วยเพราะเป็นตัวบล็อกไม่ให้ stack เต็มขึ้นได้เลย)**:

- **`docker-compose.yml` (full local stack) ไม่ได้ตั้ง `MINIO_ENDPOINT`/`ARCHIVE_S3_*`/`-config.expand-env=true` ให้ service `tempo`/`loki` เลย** — ต่างจาก `docker-compose.observability.yml` ที่มี `x-minio-env` anchor และ flag ครบ ทำให้ Tempo/Loki crash ทันทีตอน start ด้วย error `parse "http://${MINIO_ENDPOINT}": invalid character "{" in host name` (ตัวแปรไม่ถูก expand เลย) แก้โดยเพิ่ม `x-minio-env` anchor ใหม่ใน `docker-compose.yml`, wire เข้า `tempo`/`loki` service พร้อม `-config.expand-env=true`, และขยาย `minio-init` ให้สร้าง bucket `tempo-traces`/`loki-chunks` เพิ่ม (เดิมสร้างแค่ `smtrack-log-archive`)
- **`x-app-env` ไม่ได้ตั้ง `DEVICE_SECRET`** — ทำให้ `app` container crash ทันทีตอน start ด้วย `TypeError: JwtStrategy requires a secret or key` (จาก `DeviceStrategy` ที่อ่าน `config.get('deviceSecret')` ได้ค่าว่าง) แก้โดยเพิ่ม `DEVICE_SECRET: local-dev-device-secret-not-for-production` เข้า `x-app-env`
- **Healthcheck ของ `app` service ยิงผิด path** — `docker-compose.yml` ตั้ง healthcheck เป็น `http://localhost:3000/health` แต่แอปมี global prefix `log` (`app.setGlobalPrefix('log')` ใน `main.ts`) route จริงคือ `/log/health` ทำให้ container ไม่เคย report healthy แม้ทำงานปกติ แก้โดยเปลี่ยน healthcheck เป็น `http://localhost:3000/log/health`

**ผลทดสอบ log pipeline (Alloy → Loki) โดยละเอียด**:
- ยืนยันแล้วว่า `app` container รันด้วย `NODE_ENV=production` → pino ออก JSON ล้วน (ไม่ใช่ pino-pretty) Alloy parse ได้ปกติ
- Loki label ที่มาจริง: `container`, `detected_level`, `service_name` (ตรวจสอบผ่าน `/loki/api/v1/labels`) — `trace_id`/`span_id` **ไม่ปรากฏใน label list** ยืนยันว่าถูกเก็บเป็น structured metadata ตามที่ตั้งใจไว้ใน `config.alloy` ไม่ใช่ label ที่มี cardinality สูง
- ทดสอบ level mapping ที่เคยกังวลไว้ (pino `level:30`→info ตกไปที่ else-branch): ยืนยันจริงว่า `detected_level` ออกมาเป็น `info` และ `warn` ถูกต้องตามที่คาด (`level:40`→`warn`) — พฤติกรรม fallback ทำงานถูกต้องตามที่ตั้งใจไว้ ไม่ต้องแก้ `config.alloy` เพิ่ม
- Derived field (Loki → Tempo ผ่าน `trace_id`) แสดงปุ่ม "ดู trace ใน Tempo" ในทุก log line ที่มี trace context ปกติ และ trace ID ที่ได้ค้นผ่าน Tempo API (`/api/traces/{traceID}`) ตรงกับ log line จริง — ฟีเจอร์นี้ทำงานได้ตามที่ตั้งใจไว้เดิม (ไม่ได้แก้ไขในรอบนี้)

**Cleanup ที่ทำไปด้วย**: หยุด+ลบ container/volume ของ `docker-compose.observability.yml` + `docker-compose.observability.local.yml` (leftover จาก session ก่อนที่ยังไม่ได้ cleanup ตามที่เอกสารเดิมระบุ) ลบไฟล์ `.env.observability.local` และ `docker-compose.observability.local.yml` ทิ้งแล้ว, และหยุด backend process ที่ค้างอยู่บน host (`node dist/src/main`, PID เดิม) เพราะเปลี่ยนมาทดสอบผ่าน container ทั้งหมดแทน

## ปัญหาที่พบและสถานะการแก้ไข

### 1. `tracing.ts` อ่าน env ก่อน `.env` ถูกโหลด (แก้แล้ว)

**ไฟล์**: `src/main.ts`, `src/observability/tracing.ts`

`tracing.ts` ถูก import เป็นบรรทัดแรกสุดของ `main.ts` และอ่าน `process.env.OTEL_EXPORTER_OTLP_ENDPOINT` ทันทีตอน import — แต่ `ConfigModule.forRoot()` (ตัวที่โหลดไฟล์ `.env` เข้า `process.env` จริง ๆ ผ่าน dotenv) ถูกเรียกทีหลัง ตอน `NestFactory.create(AppModule)` เท่านั้น

**ผลกระทบ**: ถ้ารันด้วย `npm run start:dev` / `npm run start:prod` โดยพึ่ง `.env` ล้วน ๆ (ไม่มี process manager ที่ inject env จริงให้ เช่น PM2 ecosystem file, systemd EnvironmentFile, หรือ docker-compose `environment:`) — `OTEL_EXPORTER_OTLP_ENDPOINT` จะเป็น `undefined` เสมอ และ OTel SDK จะถูก skip ทั้งหมดโดยไม่มี warning ใด ๆ (ดู `docker/otel-collector` จะไม่มี trace/metric เข้ามาเลย โดยไม่รู้สาเหตุ)

ใน `docker-compose.yml` ปัจจุบันใช้งานได้เพราะ inject ผ่าน `environment:` ของ compose ตรง ๆ (เป็น real process env ไม่ผ่าน `.env` file) จึงไม่เจอบั๊กนี้ — แต่ deploy แบบอื่นที่พึ่ง `.env` เฉย ๆ จะเจอปัญหานี้แน่นอน

**แนวทางแก้ที่แนะนำ** (เลือกอย่างใดอย่างหนึ่ง):
- เพิ่ม `import 'dotenv/config'` เป็นบรรทัดแรกสุดของ `main.ts` ก่อน `import './observability/tracing'` (โปรเจคมี `dotenv` เป็น dependency อยู่แล้วใน `package.json`)
- หรือใช้ `-r dotenv/config` preload ใน npm script (`"start:dev": "dotenv -e .env -- nest start --watch"` หรือ `NODE_OPTIONS='-r dotenv/config'`)
- ต้องตรวจสอบว่าไม่กระทบ `NODE_ENV` behavior ของ dotenv (dotenv ไม่ override env ที่ set มาจาก shell/process manager อยู่แล้วโดย default ซึ่งเป็นพฤติกรรมที่ถูกต้อง)

### 2. Grafana Trace Search Panel ใช้ไม่ได้กับ Tempo single-binary รุ่นปัจจุบัน (แก้แล้ว — อัปเกรดเป็น 2.8.1)

**อาการ**: panel/Explore ที่ค้นหา trace แบบ list (TraceQL search, ทุก queryType ที่เป็นไปได้: `traceql`, `search`, `nativeSearch`, `traceqlSearch`) พังด้วย error `backend TraceQL search queries are not supported` หรือ `unsupported query type`

**สาเหตุที่พบ**: Grafana 11.6.0 (เวอร์ชันที่ pin ไว้ใน compose) พยายามเปิด gRPC connection ไปยัง Tempo ที่ host:port เดียวกับที่ตั้งไว้ใน datasource URL (`tempo:3200` ซึ่งเป็น HTTP port ล้วน) เพื่อทำ TraceQL search แบบ streaming — แต่ Tempo single-binary config ปัจจุบันไม่ได้ serve gRPC บน port นั้น ทำให้ handshake ล้มเหลว (`error reading server preface: http2: frame too large`)

**สิ่งที่ยังใช้งานได้ปกติ** (ไม่ต้องพึ่ง gRPC):
- ดู trace เดี่ยวจาก trace ID โดยตรง (queryType `traceId`) — ใช้ได้กับ derived field ที่ตั้งไว้ใน Loki datasource (`trace_id` → เปิด Tempo)
- Service Graph panel (nodeGraph, queryType `serviceMap`) — query ผ่าน Prometheus ไม่ผ่าน Tempo gRPC
- Span metrics ทุกตัว (`traces_spanmetrics_*`, `traces_service_graph_*`) — เป็น Prometheus metric ล้วน ๆ
- ค้นหา trace list ผ่าน Tempo HTTP API ตรง ๆ ได้ปกติ: `curl "http://localhost:3200/api/search?tags=service.name=smtrack-backend"`

**สาเหตุที่แท้จริงที่รอบก่อนพลาด**: `stream_over_http_enabled` เป็น **top-level config key** ของ Tempo (อยู่นอก `server:` ไม่ nest เข้าไปข้างใน) รอบก่อนใส่ผิดตำแหน่ง (ใต้ `server:`) ทำให้ Tempo 2.7.1 crash-loop เพราะ field นี้ไม่ได้อยู่ใน schema `server.Config` จริง ๆ — field นี้ใช้งานได้ตั้งแต่ Tempo v2.2+ สำหรับ search streaming (ไม่จำเป็นต้องอัปเกรดเวอร์ชันเพื่อให้ field นี้ใช้ได้ แค่ต้องวางตำแหน่งให้ถูก)

**วิธีแก้ที่ทำไปจริง**:
1. อัปเกรด image เป็น `grafana/tempo:2.8.1` (เวอร์ชันล่าสุดของสาย 2.x ณ ตอนแก้ — เลือกไม่กระโดดไป major version 3.x เพราะเปลี่ยน ingest/write architecture ความเสี่ยง breaking change สูงกว่าที่จำเป็น) ทั้งใน `docker-compose.yml` และ `docker-compose.observability.yml`
2. เพิ่ม `stream_over_http_enabled: true` เป็น **top-level key** (ไม่ใช่ใต้ `server:`) ใน `docker/tempo/tempo.yaml`
3. เปิด `streamingEnabled.search: true` กลับเข้า jsonData ของ Tempo datasource ใน `docker/grafana/provisioning/datasources/datasources.yaml`

**ยืนยันผ่านแล้วผ่าน Grafana Explore UI จริง** (ไม่ใช่แค่เรียก Tempo HTTP API ตรง ๆ ซึ่งใช้ได้อยู่แล้วแต่ไม่ใช่ตัวพิสูจน์ปัญหาเดิม): เปิด Explore → เลือก Tempo → พิมพ์ TraceQL query แบบ list (`{ resource.service.name = "smtrack-backend" }`) → เห็น "Streaming: Enabled", "Table - Streaming Progress: Done 100%" และได้ trace list กลับมาปกติ ไม่เจอ error `backend TraceQL search queries are not supported` อีกต่อไป

## งานที่ยังไม่ได้ทำ

1. **พิจารณาเพิ่ม alerting rules** — ปัจจุบัน Prometheus/Grafana ยังไม่มี alert rule ใด ๆ ตั้งไว้ (เช่น error rate สูงผิดปกติ, DB latency พุ่ง, MQTT/RabbitMQ ingest ล้มเหลวต่อเนื่อง) — ควรออกแบบ threshold ที่เหมาะสมกับ traffic จริงก่อนตั้ง alert (ยังไม่ได้เริ่มทำ — เป็นข้อเดียวที่เหลือจาก 5 ข้อเดิม)

ข้ออื่นที่เหลือจากรอบก่อน (ทดสอบ log pipeline, แก้บั๊ก tracing.ts, ตัดสินใจเรื่อง Tempo trace-search, ตรวจสอบ docker-compose.yml full local stack) แก้และทดสอบผ่านครบแล้ว ดูหัวข้อ "อัปเดตล่าสุด" ด้านบน

## ไฟล์ที่แก้ไข/เพิ่มระหว่างทดสอบ (คงอยู่ถาวร ไม่ใช่ของทดสอบทิ้ง)

**Session ก่อนหน้า**:
- `docker/grafana/provisioning/dashboards/dashboards.yaml` — dashboard provider config (ใหม่)
- `docker/grafana/provisioning/dashboards/smtrack-backend-overview.json` — dashboard ภาพรวม metrics (ใหม่, ภาษาไทย)
- `docker/grafana/provisioning/dashboards/smtrack-backend-traces.json` — dashboard trace/service graph (ใหม่, ภาษาไทย)

**Session นี้**:
- `src/main.ts` — เพิ่ม `import 'dotenv/config'` เป็นบรรทัดแรกสุด (แก้บั๊ก env-loading-order)
- `package.json` — ย้าย `dotenv` จาก `devDependencies` เป็น `dependencies`
- `docker/mosquitto/mosquitto.conf` — ไฟล์ใหม่ที่หายไป
- `docker-compose.yml`:
  - อัปเกรด `tempo` image เป็น `2.8.1`, เพิ่ม `-config.expand-env=true` และ `x-minio-env` ให้ `tempo`/`loki`
  - เพิ่ม `x-minio-env` anchor ใหม่, เพิ่ม `DEVICE_SECRET` เข้า `x-app-env`
  - ขยาย `minio-init` ให้สร้าง bucket `tempo-traces`/`loki-chunks` เพิ่ม
  - แก้ healthcheck ของ `app` เป็น `/log/health` (ตรงกับ global prefix จริง)
- `docker-compose.observability.yml` — อัปเกรด `tempo` image เป็น `2.8.1` (ให้ตรงกับ `docker-compose.yml`)
- `docker/tempo/tempo.yaml` — เพิ่ม `stream_over_http_enabled: true` เป็น top-level key
- `docker/grafana/provisioning/datasources/datasources.yaml` — เปิด `streamingEnabled.search: true` กลับเข้า Tempo datasource jsonData

## Query อ้างอิงที่ยืนยันแล้วว่าใช้งานได้จริง (สำหรับต่อยอด dashboard/alert)

```promql
# HTTP
sum(rate(http_server_duration_milliseconds_count[5m])) by (http_route, http_status_code)
histogram_quantile(0.95, sum(rate(http_server_duration_milliseconds_bucket[5m])) by (le, http_route))

# Database (PostgreSQL ผ่าน auto-instrumentation)
histogram_quantile(0.95, sum(rate(db_client_operation_duration_seconds_bucket[5m])) by (le, db_operation_name))

# Custom business metrics
sum(rate(smtrack_mqtt_messages_total[5m])) by (status)
sum(rate(smtrack_rmq_messages_total[5m])) by (queue, status)
sum(rate(smtrack_notification_delivery_total[5m])) by (channel, status)
histogram_quantile(0.95, sum(rate(smtrack_telemetry_ingest_duration_milliseconds_bucket[5m])) by (le))
sum(smtrack_sse_active_connections)

# Node.js runtime
sum(v8js_memory_heap_used_bytes{job="smtrack-backend"}) by (v8js_heap_space_name)
nodejs_eventloop_delay_p99_seconds{job="smtrack-backend"}

# Trace-derived (จาก Tempo metrics-generator)
sum(rate(traces_spanmetrics_calls_total{service="smtrack-backend"}[5m])) by (span_name)
histogram_quantile(0.95, sum(rate(traces_spanmetrics_latency_bucket{service="smtrack-backend"}[5m])) by (le, span_name))
sum(rate(traces_service_graph_request_total[5m])) by (client, server)
```

หมายเหตุ: **ห้ามใช้** `process_resident_memory_bytes` สำหรับแอป — ชื่อนี้ชนกับ metric self-scrape ของ Prometheus เอง (`job="prometheus"`) แอป Node.js ไม่ได้ export metric ชื่อนี้ ให้ใช้ `v8js_memory_heap_used_bytes{job="smtrack-backend"}` แทน
