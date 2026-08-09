# แผนเพิ่ม Alerting Rules (Prometheus + Alertmanager → Telegram)

> เอกสารนี้เป็นแผนงาน (ยังไม่ได้ implement) ต่อจาก `docs/observability-stack-improvement-plan.md` ข้อที่เหลือสุดท้าย ("พิจารณาเพิ่ม alerting rules") ให้ session ถัดไปนำไป implement ได้ทันทีโดยไม่ต้องสืบใหม่

## เป้าหมาย

ตั้ง alert บน Prometheus ให้ครอบคลุมจุดที่ระบบ IoT telemetry/notification นี้พังแล้วกระทบผู้ใช้จริง (ไม่ใช่ตั้งแบบทั่วไปโดยไม่ดู traffic จริง) แล้วส่งแจ้งเตือนผ่าน **Telegram** (ตามที่ผู้ใช้ระบุ) ผ่าน Alertmanager

## สถานะปัจจุบัน / Gap ที่ต้องแก้ก่อน

จากการสำรวจ `docker/prometheus/prometheus.yml` และ `docker-compose.yml`:

1. **ไม่มี Alertmanager service เลย** ใน compose ใด ๆ (`docker-compose.yml`, `docker-compose.observability.yml`) — ต้องเพิ่มใหม่ทั้งหมด
2. **`docker/prometheus/prometheus.yml` ไม่มี `rule_files:` และไม่มี `alerting:` block** — ต้องเพิ่มทั้งคู่
3. **Metric ของแอปมาจาก OTLP push เท่านั้น ไม่ใช่ scrape** (`--web.enable-otlp-receiver`, comment ในไฟล์ระบุไว้ชัดว่า "แอปไม่ได้เปิด /metrics endpoint") — แปลว่า **ใช้ `up{job="smtrack-backend"}` เพื่อเช็คว่าแอปตายไม่ได้** เพราะไม่มี scrape target ของแอปเลย ต้องออกแบบ "app down" alert ด้วยวิธีอื่น (ดูหัวข้อ Alert Rules ข้อ 1.2)
4. **RabbitMQ ไม่ได้เปิด `rabbitmq_prometheus` plugin** (image `rabbitmq:3-management-alpine` มี management plugin แต่ยังไม่เปิด prometheus plugin, ไม่มี scrape job สำหรับมันใน `prometheus.yml`) — แปลว่า **alert เรื่อง queue depth/backlog ทำไม่ได้ในตอนนี้** จนกว่าจะเปิด plugin นี้เพิ่ม (ดูหัวข้อ "งานเสริมนอกขอบเขต" ท้ายเอกสาร) — ตอนนี้ทำได้แค่ alert จาก `smtrack_rmq_messages_total{status="error"}` ที่แอป export เอง (นับ error ตอน consume ไม่ใช่ queue depth)
5. **Prometheus ยังไม่เปิด `--web.enable-lifecycle`** — ต้องเปิดเพื่อให้ reload rule files ด้วย `POST /-/reload` ได้โดยไม่ต้อง restart container

## สถาปัตยกรรม

```
Prometheus (evaluate rules ทุก scrape_interval)
  → rule_files: /etc/prometheus/alert-rules.yml
  → alerting.alertmanagers: [alertmanager:9093]
       ↓
Alertmanager (group/dedupe/route alert)
  → receiver: telegram_configs (native ตั้งแต่ Alertmanager v0.24+ ไม่ต้องใช้ webhook shim)
```

ไม่ต้องมี relay/webhook กลางเพิ่ม เพราะ Alertmanager รองรับ `telegram_configs` เป็น receiver type ในตัวอยู่แล้ว

## ไฟล์ที่ต้องเพิ่ม/แก้

### 1. `docker/alertmanager/alertmanager.yml` (ใหม่)

```yaml
global:
  resolve_timeout: 5m

route:
  receiver: telegram-default
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 3h
  routes:
    # critical แยกไปกลุ่มเดียวกันแต่ repeat ถี่กว่า จะได้ไม่พลาด
    - match:
        severity: critical
      repeat_interval: 30m

receivers:
  - name: telegram-default
    telegram_configs:
      - bot_token: '${TELEGRAM_BOT_TOKEN}'
        chat_id: ${TELEGRAM_CHAT_ID}
        parse_mode: 'HTML'
        message: |
          <b>{{ .CommonLabels.alertname }}</b> [{{ .CommonLabels.severity }}]
          {{ range .Alerts }}{{ .Annotations.summary }}
          {{ .Annotations.description }}
          {{ end }}

inhibit_rules:
  # ถ้า app ตายทั้งตัวอยู่แล้ว ไม่ต้องยิง alert ย่อยซ้ำ (error rate, latency ฯลฯ)
  - source_matchers: ['alertname = SmtrackAppDown']
    target_matchers: ['severity =~ warning|critical']
    equal: ['job']
```

- `bot_token`/`chat_id` ต้องมาจาก env var จริง ไม่ hardcode — Alertmanager config รองรับ `${VAR}` ผ่าน `--config.expand-env` flag (ต้องเปิดใน command ตอน start เหมือนที่ Tempo/Loki ทำ) หรือใช้ `envsubst` render config ก่อน mount ก็ได้ถ้าไม่อยากพึ่ง flag นี้
- ต้องสร้าง Telegram bot ใหม่ผ่าน `@BotFather` แล้วหา `chat_id` ของกลุ่ม/ผู้ใช้ที่จะรับแจ้งเตือน (ไม่ใช่งานฝั่งโค้ด — ผู้ใช้ต้องทำเองแล้วส่ง token/chat_id มาเป็น secret)

### 2. `docker/prometheus/alert-rules.yml` (ใหม่)

ดูรายละเอียด rule ทั้งหมดในหัวข้อ "Alert Rules" ด้านล่าง — ไฟล์นี้จะรวม group ทั้งหมดไว้ในไฟล์เดียว (จำนวน rule ยังน้อยพอ ไม่จำเป็นต้องแยกหลายไฟล์)

### 3. แก้ `docker/prometheus/prometheus.yml`

เพิ่มสองบล็อกนี้เข้าไป (ของเดิมที่มีอยู่ไม่ต้องแก้):

```yaml
rule_files:
  - /etc/prometheus/alert-rules.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']
```

### 4. แก้ `docker-compose.yml` (และ `docker-compose.observability.yml` คู่กันถ้าจะใช้ alert บน stack นั้นด้วย)

- เพิ่ม service `alertmanager`:
  ```yaml
  alertmanager:
    image: prom/alertmanager:v0.28.1
    command:
      - '--config.file=/etc/alertmanager/alertmanager.yml'
      - '--config.expand-env=true'
    environment:
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID}
    volumes:
      - ./docker/alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
      - alertmanager-data:/alertmanager
    ports: ['9093:9093']
  ```
- เพิ่ม volume `alertmanager-data:` ในหัวข้อ `volumes:`
- แก้ `prometheus` service: mount `./docker/prometheus/alert-rules.yml:/etc/prometheus/alert-rules.yml:ro` เพิ่ม, เพิ่ม `--web.enable-lifecycle` เข้า `command:`, เพิ่ม `depends_on: [alertmanager]`
- เพิ่ม `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` เข้า `.env.example` (ไม่ใส่ค่าจริง — เป็น secret ที่ผู้ใช้ต้องกรอกเอง)

## Alert Rules ที่แนะนำ

อิงจาก metric ที่ยืนยันแล้วว่า export จริงจากแอป (ดู query อ้างอิงใน `docs/observability-stack-improvement-plan.md`) จัดกลุ่มตามความรุนแรง — **threshold ทุกตัวเป็นจุดเริ่มต้นเท่านั้น ต้องปรับตาม traffic จริงหลังเก็บข้อมูล baseline อย่างน้อย 1-2 สัปดาห์**

### กลุ่ม 1: Availability (severity: critical)

**1.1 otel-collector ไม่ตอบสนอง**
```yaml
- alert: SmtrackOtelCollectorDown
  expr: up{job="otel-collector"} == 0
  for: 2m
  labels: { severity: critical }
  annotations:
    summary: "otel-collector ไม่ตอบสนอง"
    description: "Prometheus scrape otel-collector:8888 ไม่ได้เกิน 2 นาที — trace/metric จากแอปจะไม่เข้าระบบทั้งหมด"
```

**1.2 แอปหยุดส่ง metric เข้ามา (proxy สำหรับ "app down" เพราะไม่มี scrape target ตรง — ดู Gap ข้อ 3)**
```yaml
- alert: SmtrackAppMetricsStopped
  expr: absent_over_time(http_server_duration_milliseconds_count{job="smtrack-backend"}[10m])
  for: 0m
  labels: { severity: critical }
  annotations:
    summary: "แอปไม่ส่ง HTTP metric เข้ามาเกิน 10 นาที"
    description: "อาจเป็นเพราะแอป crash, OTel SDK ไม่ start (ดูบั๊ก tracing.ts เดิม), หรือ otel-collector รับ metric ไม่ได้ — ต้องเช็ค container logs ประกอบ เพราะ query นี้ inference จาก \"ไม่มี HTTP request เข้าเลย\" ไม่ใช่ health check ตรง ๆ"
```
- **ข้อควรระวัง**: alert นี้ false-positive ได้ถ้าระบบจริง ๆ ไม่มี HTTP traffic เข้ามาเลยในช่วงนั้น (เช่น dev/staging ที่ไม่มีคนใช้) — เหมาะกับ production ที่มี traffic สม่ำเสมอเท่านั้น ก่อน deploy จริงควรยืนยันกับ traffic pattern จริงของ production ก่อน

### กลุ่ม 2: HTTP / API (severity: warning ยกเว้นระบุ)

**2.1 HTTP 5xx error rate สูงผิดปกติ**
```yaml
- alert: SmtrackHttpErrorRateHigh
  expr: |
    sum(rate(http_server_duration_milliseconds_count{job="smtrack-backend", http_status_code=~"5.."}[5m]))
    /
    sum(rate(http_server_duration_milliseconds_count{job="smtrack-backend"}[5m])) > 0.05
  for: 5m
  labels: { severity: critical }
  annotations:
    summary: "HTTP 5xx error rate เกิน 5% ใน 5 นาทีล่าสุด"
    description: "{{ $value | humanizePercentage }} ของ request ทั้งหมดเป็น 5xx"
```

**2.2 HTTP p95 latency สูงผิดปกติ**
```yaml
- alert: SmtrackHttpLatencyHigh
  expr: |
    histogram_quantile(0.95,
      sum(rate(http_server_duration_milliseconds_bucket{job="smtrack-backend"}[5m])) by (le, http_route)
    ) > 2000
  for: 10m
  labels: { severity: warning }
  annotations:
    summary: "HTTP p95 latency เกิน 2 วินาที ที่ route {{ $labels.http_route }}"
```

### กลุ่ม 3: Database (severity: warning/critical)

**3.1 DB query p95 latency สูง**
```yaml
- alert: SmtrackDbLatencyHigh
  expr: |
    histogram_quantile(0.95,
      sum(rate(db_client_operation_duration_seconds_bucket{job="smtrack-backend"}[5m])) by (le, db_operation_name)
    ) > 1
  for: 10m
  labels: { severity: warning }
  annotations:
    summary: "DB query p95 latency เกิน 1 วินาที ({{ $labels.db_operation_name }})"
```

### กลุ่ม 4: MQTT / RabbitMQ ingest (severity: critical — กระทบข้อมูล telemetry โดยตรง)

**4.1 MQTT ingest error rate สูง**
```yaml
- alert: SmtrackMqttIngestErrorsHigh
  expr: |
    sum(rate(smtrack_mqtt_messages_total{status="error"}[5m]))
    /
    sum(rate(smtrack_mqtt_messages_total[5m])) > 0.1
  for: 5m
  labels: { severity: critical }
  annotations:
    summary: "MQTT message ingest error rate เกิน 10%"
    description: "อุปกรณ์ IoT อาจส่ง payload ผิด schema จำนวนมาก หรือ MQTT broker/DB มีปัญหา"
```

**4.2 RabbitMQ consumer error rate สูง**
```yaml
- alert: SmtrackRabbitmqIngestErrorsHigh
  expr: |
    sum(rate(smtrack_rmq_messages_total{status="error"}[5m])) by (queue)
    /
    sum(rate(smtrack_rmq_messages_total[5m])) by (queue) > 0.1
  for: 5m
  labels: { severity: critical }
  annotations:
    summary: "RabbitMQ consumer error rate เกิน 10% ที่ queue {{ $labels.queue }}"
```

**4.3 MQTT/RabbitMQ หยุดรับข้อความเลย (ingest หยุดทำงาน)**
```yaml
- alert: SmtrackMqttIngestStalled
  expr: absent_over_time(smtrack_mqtt_messages_total[15m])
  for: 0m
  labels: { severity: critical }
  annotations:
    summary: "ไม่มี MQTT message เข้ามาเลยเกิน 15 นาที"
    description: "อุปกรณ์ IoT อาจหยุดส่งข้อมูลทั้งหมด หรือ MQTT client ในแอปหลุดการเชื่อมต่อ — เช็ค MqttClientService logs ประกอบ"
```
- เช่นเดียวกับ 1.2 — ต้องยืนยัน traffic pattern จริงก่อนตั้ง threshold นี้ ถ้าอุปกรณ์บางตัวส่งข้อมูลนาน ๆ ครั้งอาจ false-positive

### กลุ่ม 5: Notification delivery (severity: warning)

**5.1 Notification delivery failure rate สูง (SSE/FCM)**
```yaml
- alert: SmtrackNotificationDeliveryFailuresHigh
  expr: |
    sum(rate(smtrack_notification_delivery_total{status="failed"}[15m])) by (channel)
    /
    sum(rate(smtrack_notification_delivery_total[15m])) by (channel) > 0.2
  for: 10m
  labels: { severity: warning }
  annotations:
    summary: "Notification delivery failure rate เกิน 20% ที่ channel {{ $labels.channel }}"
    description: "ถ้า channel=fcm อาจเป็นปัญหา Firebase credential/quota, ถ้า channel=sse อาจเป็นปัญหา client disconnect ผิดปกติ"
```

### กลุ่ม 6: Node.js runtime (severity: warning)

**6.1 Event loop lag สูง**
```yaml
- alert: SmtrackEventLoopLagHigh
  expr: nodejs_eventloop_delay_p99_seconds{job="smtrack-backend"} > 0.5
  for: 10m
  labels: { severity: warning }
  annotations:
    summary: "Node.js event loop p99 delay เกิน 500ms"
    description: "อาจมี synchronous/blocking operation ทำงานหนักเกินไปในโปรเซสเดียว"
```

**6.2 Heap memory โตต่อเนื่อง (สัญญาณ memory leak)**
```yaml
- alert: SmtrackHeapMemoryHigh
  expr: sum(v8js_memory_heap_used_bytes{job="smtrack-backend"}) by (v8js_heap_space_name) > 1.5e9
  for: 15m
  labels: { severity: warning }
  annotations:
    summary: "V8 heap usage เกิน 1.5GB ต่อเนื่อง 15 นาที ({{ $labels.v8js_heap_space_name }})"
```
- threshold นี้ต้องปรับตาม memory limit จริงของ container/VM ที่ deploy — 1.5GB เป็นแค่ตัวอย่างเริ่มต้น

### กลุ่ม 7: SSE (severity: info/warning)

**7.1 SSE active connections หายวูบ (บ่งชี้ SSE module พังหรือ restart ไม่คาดคิด)**
```yaml
- alert: SmtrackSseConnectionsDroppedToZero
  expr: |
    sum(smtrack_sse_active_connections) == 0
    and
    sum(smtrack_sse_active_connections offset 15m) > 0
  for: 5m
  labels: { severity: warning }
  annotations:
    summary: "SSE active connections ตกลงเหลือ 0 จากที่เคยมี client เชื่อมต่ออยู่"
```

## ลำดับการ implement ที่แนะนำ

1. สร้าง Telegram bot + หา chat_id (งานของผู้ใช้ ไม่ใช่โค้ด) แล้วเพิ่ม `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` เข้า `.env` จริง + `.env.example` (placeholder เท่านั้น)
2. เพิ่ม `docker/alertmanager/alertmanager.yml`, `docker/prometheus/alert-rules.yml`
3. แก้ `docker/prometheus/prometheus.yml` เพิ่ม `rule_files`/`alerting` block
4. แก้ `docker-compose.yml` เพิ่ม service `alertmanager`, volume `alertmanager-data`, แก้ `prometheus` service (mount rule file, `--web.enable-lifecycle`, `depends_on`)
5. `docker compose up -d --build` แล้วยืนยัน:
   - `http://localhost:9090/rules` เห็น rule ทั้งหมด status `ok` ไม่ใช่ `err` (syntax ผิดจะขึ้น error ตรงนี้)
   - `http://localhost:9090/alerts` เห็น alert state (inactive/pending/firing)
   - `http://localhost:9093` (Alertmanager UI) เห็น alert ที่ fire จริง
   - ทดสอบยิง alert จริงอย่างน้อย 1 ตัวแบบ manual (เช่น หยุด `otel-collector` container ชั่วคราวให้ `SmtrackOtelCollectorDown` fire) แล้วยืนยันว่า Telegram ได้รับข้อความจริง
6. ปรับ threshold ทุกตัวหลังเก็บข้อมูล production traffic จริงอย่างน้อย 1-2 สัปดาห์ — ค่าที่ตั้งในเอกสารนี้เป็นจุดเริ่มต้นเท่านั้น โดยเฉพาะกลุ่ม absence-based (1.2, 4.3) ที่เสี่ยง false-positive สูงถ้า traffic ไม่สม่ำเสมอ

## งานเสริมนอกขอบเขต (ไม่รวมในแผนนี้ แต่เป็นข้อจำกัดที่ควรรู้)

- **RabbitMQ queue depth alert** — ต้องเปิด `rabbitmq_prometheus` plugin ในอิมเมจ (`rabbitmq-plugins enable rabbitmq_prometheus`, expose port 15692) แล้วเพิ่ม scrape job ใน `prometheus.yml` ก่อนถึงจะ alert เรื่อง queue backlog (`rabbitmq_queue_messages_ready`) ได้จริง — ตอนนี้มีแค่ error-rate alert จากฝั่งแอป (ข้อ 4.2) ซึ่งไม่เท่ากับ queue depth
- **Silence/maintenance window** — ยังไม่ได้ออกแบบ workflow สำหรับ silence alert ตอน deploy/maintenance ที่ตั้งใจ (Alertmanager รองรับผ่าน UI/API `POST /api/v2/silences` อยู่แล้ว แต่ยังไม่ได้ document วิธีใช้ให้ทีม)
- **Alertmanager high availability** — ตอนนี้ออกแบบเป็น instance เดียว เหมาะกับ dev/staging/small production เท่านั้น ถ้า traffic โตมากควรพิจารณา Alertmanager cluster mode (`--cluster.peer`) ภายหลัง
