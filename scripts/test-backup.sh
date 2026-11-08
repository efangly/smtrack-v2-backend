#!/usr/bin/env bash
#
# ทดสอบระบบ archive (export/drop/restore) กับ TimescaleDB + S3 จริง โดยไม่แตะ DB หรือ bucket ของใคร
#
#   bash scripts/test-backup.sh
#
# ขึ้น container ชั่วคราว 2 ตัว (ชื่อ archive-test-db / archive-test-s3, ไม่มี volume) รัน migration จริง
# seed ข้อมูลหลายเดือนครบ 4 ตาราง แล้วรัน CLI (node dist/cli/archive-job) หลายสถานการณ์ ตามด้วย e2e
# ที่คุยกับ DB/S3 ชุดเดียวกัน จบแล้วลบ container ทิ้งเสมอ (trap) exit 0 = ผ่านทุกเคส
#
# ต้องมี: docker, node/npm (ติดตั้ง dependency แล้ว), psql ไม่จำเป็น (ใช้ผ่าน docker exec)
#
# หมายเหตุ: ใช้ adobe/s3mock เป็น S3 เพราะ image ของ MinIO ถูกถอดออกจาก Docker Hub/quay.io แล้ว
# (docker-compose.yml ของโปรเจกต์ยังอ้าง minio/minio:RELEASE.2025-04-22T22-12-26Z ซึ่งดึงไม่ได้อีก)
# ตัว code คุยผ่าน AWS SDK มาตรฐานจึงใช้ได้กับทุก S3-compatible

set -uo pipefail
cd "$(dirname "$0")/.."

DB=archive-test-db
S3=archive-test-s3
DB_PORT="${ARCHIVE_TEST_DB_PORT:-55432}"
S3_PORT="${ARCHIVE_TEST_S3_PORT:-59090}"
BUCKET=smtrack-log-archive

export DATABASE_URL="postgresql://postgres:postgres@localhost:${DB_PORT}/smtrack_test"
export ARCHIVE_S3_ENDPOINT="http://localhost:${S3_PORT}"
export ARCHIVE_S3_ACCESS_KEY=x ARCHIVE_S3_SECRET_KEY=x ARCHIVE_S3_BUCKET="$BUCKET"
export ARCHIVE_S3_FORCE_PATH_STYLE=true ARCHIVE_S3_REGION=us-east-1 NODE_ENV=production

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n      %s\n' "$1" "$2"; }
step(){ printf '\n\033[1m%s\033[0m\n' "$1"; }
check_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "ได้ '$2' คาดว่า '$3'"; fi; }
psql_q() { docker exec "$DB" psql -U postgres -d smtrack_test -Atc "$1"; }
psql_run() { docker exec "$DB" psql -U postgres -d smtrack_test -q -c "$1" >/dev/null; }
cli() { node dist/cli/archive-job "$@" >/tmp/archive-test-cli.log 2>&1; echo $?; }
logs() { sed 's/\x1b\[[0-9;]*m//g' /tmp/archive-test-cli.log; }

cleanup() { docker rm -f "$DB" "$S3" >/dev/null 2>&1 || true; }
trap cleanup EXIT

step "0. เตรียมสภาพแวดล้อม"
docker info >/dev/null 2>&1 || { echo "docker ไม่ทำงาน"; exit 2; }
cleanup
docker run -d --name "$DB" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=smtrack_test \
  -p "${DB_PORT}:5432" timescale/timescaledb:latest-pg17 >/dev/null || exit 2
docker run -d --name "$S3" -p "${S3_PORT}:9090" adobe/s3mock:latest >/dev/null || exit 2
for _ in $(seq 1 60); do docker exec "$DB" pg_isready -U postgres -d smtrack_test >/dev/null 2>&1 && break; sleep 1; done
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://localhost:${S3_PORT}/${BUCKET}")" = "200" ] && break; sleep 1
done
sleep 3 # timescaledb restart หลัง init
for _ in $(seq 1 30); do docker exec "$DB" pg_isready -U postgres -d smtrack_test >/dev/null 2>&1 && break; sleep 1; done

npx prisma migrate deploy >/tmp/archive-test-migrate.log 2>&1 \
  && ok "migration ทั้งหมด (รวม 20261101000000_archive_multi_table_and_jobs) apply ผ่านบน TimescaleDB จริง" \
  || { bad "migration" "$(tail -5 /tmp/archive-test-migrate.log)"; exit 1; }
npm run build >/tmp/archive-test-build.log 2>&1 || { bad "build" "$(tail -5 /tmp/archive-test-build.log)"; exit 1; }

step "1. seed ข้อมูล 7 เดือนล่าสุด × 4 ตาราง (สัมพัทธ์กับวันนี้)"
docker exec -i "$DB" psql -U postgres -d smtrack_test -q <<'SQL'
INSERT INTO hardware (id, serial) VALUES ('hw-1','SN-T1'),('hw-2','SN-T2');
INSERT INTO devices (id, serial, static_name, seq, tenant_id) VALUES
  ('dev-1','SN-T1','FRIDGE-1',1,'T1'),('dev-2','SN-T2','FRIDGE-2',2,'T1');
INSERT INTO device_assignments (id, device_id, serial) VALUES ('as-1','dev-1','SN-T1'),('as-2','dev-2','SN-T2');
CREATE TEMP TABLE months AS
  SELECT generate_series(date_trunc('month', now() AT TIME ZONE 'UTC') - interval '6 months',
                         date_trunc('month', now() AT TIME ZONE 'UTC'), interval '1 month') AS m;
INSERT INTO log_days (id, serial, device_id, temp, send_time, create_at)
SELECT 'ld-' || d.id || '-' || to_char(m,'YYYYMM') || '-' || g, d.serial, d.id, 4 + (g % 5),
       m + (g * interval '18 hours'), m + (g * interval '18 hours')
FROM (VALUES ('dev-1','SN-T1'),('dev-2','SN-T2')) AS d(id, serial), months, generate_series(0, 39) AS g
WHERE m + (g * interval '18 hours') < m + interval '1 month';
INSERT INTO notifications (id, serial, message, detail, device_id, create_at, update_at)
SELECT 'n-' || to_char(m,'YYYYMM') || '-' || g, 'SN-T1', 'temp high',
       E'line1\nline2 "quoted", comma\nline3', 'dev-1', m + (g * interval '1 day'), m + (g * interval '1 day')
FROM months, generate_series(0,4) g;
INSERT INTO device_audit (id, device_id, static_name, action, snapshot, create_at)
SELECT 'da-' || to_char(m,'YYYYMM'), 'dev-1','FRIDGE-1','updated', '{"a":"x\ny","b":[1,2]}'::jsonb, m + interval '2 days' FROM months;
INSERT INTO user_audit (id, entity_type, entity_id, action, snapshot, create_at)
SELECT 'ua-' || to_char(m,'YYYYMM'), 'device','dev-1','updated', '{"k":"v"}'::jsonb, m + interval '3 days' FROM months;
SQL
[ $? -eq 0 ] && ok "seed สำเร็จ" || { bad "seed" "psql ล้มเหลว"; exit 1; }

# จำนวนเดือนที่ "จบแล้ว" (ก่อนเดือนปัจจุบัน) ของ log_days = ควรถูก archive ทั้งหมด
COMPLETE=$(psql_q "SELECT count(*) FROM generate_series(date_trunc('month', (SELECT min(send_time) FROM log_days)), date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month', interval '1 month')")
LD_TOTAL=$(psql_q "SELECT count(*) FROM log_days")

step "2. dry-run: ไม่ export ไม่ลบอะไร"
CODE=$(cli export-and-drop --dry-run)
check_eq "dry-run exit 0" "$CODE" "0"
check_eq "dry-run ไม่สร้าง archive_export" "$(psql_q 'SELECT count(*) FROM archive_export')" "0"
check_eq "dry-run ไม่ลบ log_days" "$(psql_q 'SELECT count(*) FROM log_days')" "$LD_TOTAL"
check_eq "dry-run ไม่เขียน archive_job_run" "$(psql_q 'SELECT count(*) FROM archive_job_run')" "0"

step "2b. ซ้อม cut-over: backfill (archive ข้อมูลเก่าโดยไม่ลบ) → verify (พร้อมถอด retention policy ไหม)"
CODE=$(cli backfill --dry-run)
check_eq "backfill --dry-run exit 0" "$CODE" "0"
check_eq "backfill --dry-run ไม่สร้าง archive_export" "$(psql_q 'SELECT count(*) FROM archive_export')" "0"
check_eq "backfill --dry-run รายงานแถวต่อเดือนจาก DB" "$([ "$(logs | grep -c 'rows in database')" -gt 0 ] && echo yes || echo no)" "yes"

CODE=$(cli verify)
check_eq "verify ก่อน backfill ต้องไม่ผ่าน (ยังมีเดือนเก่าที่ไม่มี archive)" "$CODE" "1"
check_eq "verify บอกว่ายังไม่พร้อม" "$([ "$(logs | grep -c 'NOT ready')" -gt 0 ] && echo yes || echo no)" "yes"

CODE=$(cli backfill)
check_eq "backfill exit 0" "$CODE" "0"
for T in log_days notifications device_audit user_audit; do
  check_eq "backfill archive ครบ ($T)" "$(psql_q "SELECT count(*) FROM archive_export WHERE source_table='$T'")" "$COMPLETE"
done
check_eq "backfill ไม่ลบข้อมูลเลย (log_days เท่าเดิม)" "$(psql_q 'SELECT count(*) FROM log_days')" "$LD_TOTAL"
check_eq "backfill บันทึกเป็น job backfill ทั้งหมด" "$(psql_q "SELECT count(*) FROM archive_job_run WHERE job <> 'backfill'")" "0"

CODE=$(cli verify)
check_eq "verify หลัง backfill ผ่าน (exit 0)" "$CODE" "0"
check_eq "verify รายงาน CUT-OVER READY" "$([ "$(logs | grep -c 'CUT-OVER READY')" -gt 0 ] && echo yes || echo no)" "yes"

# ทำลายไฟล์ archive จริงบน S3 แล้ว verify ต้องจับได้ (ไม่เชื่อแค่ตัวเลขใน DB)
V_KEY=$(psql_q "SELECT object_key FROM archive_export WHERE source_table='log_days' ORDER BY month LIMIT 1")
V_MONTH=$(psql_q "SELECT month FROM archive_export WHERE source_table='log_days' ORDER BY month LIMIT 1")
printf 'id,v\nx,1\n' | gzip | curl -s -X PUT --data-binary @- "http://localhost:${S3_PORT}/${BUCKET}/${V_KEY}" -o /dev/null
CODE=$(cli verify --table=log_days)
check_eq "verify จับไฟล์ที่ถูกแก้ได้ (exit 1)" "$CODE" "1"
check_eq "ระบุเดือนและสาเหตุ (sha256 differs)" "$([ "$(logs | grep -c "log_days ${V_MONTH:0:7}: sha256 differs\|log_days ${V_MONTH:0:7}: row count")" -gt 0 ] && echo yes || echo no)" "yes"
curl -s -X DELETE "http://localhost:${S3_PORT}/${BUCKET}/${V_KEY}" -o /dev/null
CODE=$(cli verify --table=log_days)
check_eq "verify จับไฟล์ที่หาย (exit 1)" "$CODE" "1"
check_eq "ระบุว่า object missing" "$([ "$(logs | grep -c 'object missing')" -gt 0 ] && echo yes || echo no)" "yes"
# ซ่อม: ลบ record แล้ว backfill ใหม่ (ข้อมูลยังอยู่ใน DB เพราะยังไม่ drop)
psql_run "DELETE FROM archive_export WHERE source_table='log_days' AND month='$V_MONTH'"
CODE=$(cli backfill --table=log_days)
check_eq "backfill ซ่อมเดือนที่เสีย exit 0" "$CODE" "0"
CODE=$(cli verify)
check_eq "verify ผ่านอีกครั้งหลังซ่อม" "$CODE" "0"
psql_run "DELETE FROM archive_job_run"

step "3. export-and-drop จริง (หลัง backfill: ไม่ต้อง export ซ้ำ เหลือแค่ drop chunk ที่มี archive ยืนยันแล้ว)"
CODE=$(cli export-and-drop)
check_eq "exit 0" "$CODE" "0"
for T in log_days notifications device_audit user_audit; do
  check_eq "archive ครบทุกเดือนที่จบแล้ว ($T)" "$(psql_q "SELECT count(*) FROM archive_export WHERE source_table='$T'")" "$COMPLETE"
done
check_eq "ทุก archive_job_run ที่ทำจบเป็น succeeded" "$(psql_q "SELECT count(*) FROM archive_job_run WHERE status <> 'succeeded'")" "0"
check_eq "export-and-drop ไม่ export ซ้ำ (backfill ทำไว้แล้ว) แต่ drop" "$(logs | grep -c 'exporting ')" "0"
# ไฟล์บน S3 มีจริงและ sha ตรง: นับ object ของ log_days
OBJS=$(curl -s "http://localhost:${S3_PORT}/${BUCKET}?list-type=2&prefix=log-days/" | grep -o '<Key>[^<]*csv.gz</Key>' | wc -l | tr -d ' ')
check_eq "มีไฟล์ log_days.csv.gz บน S3 ครบ" "$OBJS" "$COMPLETE"
check_eq "ไม่มีไฟล์ .staging ค้าง" "$(curl -s "http://localhost:${S3_PORT}/${BUCKET}?list-type=2" | grep -c '\.staging')" "0"
HOT_ONLY=$(psql_q "SELECT count(*) FROM log_days WHERE send_time < date_trunc('month', (now() AT TIME ZONE 'UTC') - interval '30 days') - interval '1 month'")
check_eq "ไม่มีแถวเก่ากว่า hot window หลงเหลือ (chunk ที่ archive แล้วถูก drop)" "$HOT_ONLY" "0"
DROPPED=$(( LD_TOTAL - $(psql_q 'SELECT count(*) FROM log_days') ))
[ "$DROPPED" -gt 0 ] && ok "chunk ถูก drop จริง ($DROPPED แถวออกจาก log_days)" || bad "drop_chunks" "ไม่มีแถวถูกลบเลย"

step "4. รันซ้ำ: no-op และไม่ export ทับ (chunk คาบเกี่ยวขอบเดือนทำให้ DB เหลือแถวน้อยกว่า archive)"
SUMS_BEFORE=$(psql_q "SELECT string_agg(source_table||month||sha256, ',' ORDER BY source_table, month) FROM archive_export")
CODE=$(cli export-and-drop)
check_eq "exit 0" "$CODE" "0"
check_eq "archive_export ไม่เปลี่ยน (sha256 เดิมทุกเดือน)" "$(psql_q "SELECT string_agg(source_table||month||sha256, ',' ORDER BY source_table, month) FROM archive_export")" "$SUMS_BEFORE"
check_eq "ไม่มีการ export ใหม่ในรอบที่สอง" "$(logs | grep -c 'exporting ')" "0"

step "5. advisory lock: มีอีกตัวถืออยู่ → ข้าม exit 0 และบันทึก skipped"
( docker exec "$DB" psql -U postgres -d smtrack_test -qAtc "SELECT pg_advisory_lock(hashtext('archive-job:export-and-drop')); SELECT pg_sleep(8);" >/dev/null 2>&1 & )
sleep 2
CODE=$(cli export-and-drop)
check_eq "exit 0" "$CODE" "0"
check_eq "บันทึก skipped" "$(psql_q "SELECT count(*) FROM archive_job_run WHERE status='skipped'")" "1"
sleep 7

step "6. S3 ล่ม: exit 1, บันทึก failed พร้อมสาเหตุที่อ่านรู้เรื่อง, ไม่ลบข้อมูลที่ยังไม่มีสำเนา"
# เดือนล่าสุดที่จบแล้ว: ยังอยู่ใน hot window (ไม่ถูก drop) — ลบ record เพื่อให้ถือว่ายังไม่ archive
LAST=$(psql_q "SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month', 'YYYY-MM-DD')")
psql_run "DELETE FROM archive_export WHERE source_table='log_days' AND month='$LAST'"
BEFORE=$(psql_q "SELECT count(*) FROM log_days")
CODE=$(ARCHIVE_S3_ENDPOINT=http://localhost:1 cli export-and-drop --table=log_days)
check_eq "exit 1" "$CODE" "1"
check_eq "สถานะ failed ถูกบันทึก" "$(psql_q "SELECT count(*) FROM archive_job_run WHERE status='failed' AND source_table='log_days' AND job='export-and-drop'")" "1"
[ -n "$(psql_q "SELECT error FROM archive_job_run WHERE status='failed' LIMIT 1")" ] && ok "error ไม่ว่างเปล่า ($(psql_q "SELECT left(error,40) FROM archive_job_run WHERE status='failed' LIMIT 1"))" || bad "ข้อความ error" "ว่างเปล่า"
check_eq "ไม่ลบแถวใด ๆ ของ log_days" "$(psql_q "SELECT count(*) FROM log_days")" "$BEFORE"
step "7. S3 กลับมา: รอบถัดไปซ่อมเอง"
CODE=$(cli export-and-drop --table=log_days)
check_eq "exit 0" "$CODE" "0"
check_eq "เดือนที่ค้างถูก archive แล้ว" "$(psql_q "SELECT count(*) FROM archive_export WHERE source_table='log_days' AND month='$LAST'")" "1"

step "8. e2e กับ DB/S3 ชุดเดียวกัน (on-demand restore, TTL, 202, scope, ผสานข้อมูลมาช้า, ไฟล์ legacy)"
npx jest --config test/jest-e2e.json test/ondemand-restore.e2e-spec.ts test/backup-archive.e2e-spec.ts \
  >/tmp/archive-test-e2e.log 2>&1
E2E=$?
grep -E "Tests:|Test Suites:" /tmp/archive-test-e2e.log | sed 's/^/      /'
[ $E2E -eq 0 ] && ok "e2e ผ่านทั้งหมด" || bad "e2e" "ดู /tmp/archive-test-e2e.log"

printf '\n\033[1mสรุป: ผ่าน %d, ไม่ผ่าน %d\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
