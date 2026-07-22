#!/usr/bin/env bash
#
# ทดสอบระบบ backup/restore ครบวงจรบน docker compose
#
#   docker compose up -d --build
#   bash scripts/test-backup.sh
#
# exit 0 = ผ่านทุกเคส. ผลดิบของแต่ละเคสเก็บไว้ที่ $ARTIFACT_DIR
#
# หมายเหตุเรื่องเวลา: restoreMonth บล็อกเดือนที่ยังอยู่ใน retention window และ
# TimescaleDB มี retention policy drop LogDays ที่เก่ากว่า 6 เดือนทิ้ง
# สคริปต์นี้จึงปิด retention policy ชั่วคราว → seed เดือน M-7 → export →
# DELETE เองเพื่อจำลอง chunk drop → restore   (ไม่แตะนาฬิกา container)

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
BUCKET="${ARCHIVE_S3_BUCKET:-smtrack-log-archive}"
ARTIFACT_DIR="${ARTIFACT_DIR:-/tmp/backup-report}"
SERIAL_PREFIX="BK-"
SERIAL="${SERIAL_PREFIX}001"
ROWS=5000

# เดือนเป้าหมาย = 7 เดือนก่อน (นอก retention window 6 เดือน จึง restore ได้)
# ใช้ psql คำนวณ เพื่อให้ตรงกับ timezone/ปฏิทินของ DB ไม่ใช่ของ host
TARGET_MONTH=""
CURRENT_MONTH=""

PASS=0
FAIL=0
declare -a RESULTS=()

# ── helpers ──────────────────────────────────────────────────────────────────

psql_q() { # รัน SQL คืนค่าเดียวแบบไม่มี header/ช่องว่าง
  docker compose exec -T timescaledb psql -U postgres -d smtrack -tAc "$1"
}

psql_run() { # รัน SQL ที่ไม่สนใจผลลัพธ์
  docker compose exec -T timescaledb psql -U postgres -d smtrack -q -c "$1" >/dev/null
}

mc_exec() { # mc ใน container ของตัวเอง (image minio/mc ไม่มี shell tools ครบ จึงใช้ minio)
  docker compose exec -T minio mc "$@"
}

http_code() { # คืน HTTP status code อย่างเดียว
  curl -s -o "$ARTIFACT_DIR/last-body.json" -w '%{http_code}' -X "$1" "$BASE_URL$2"
}

# ดึงค่าตัวเลขจาก JSON — รองรับทั้งแบบ compact (response ของ Nest)
# และแบบ pretty-print (meta.json ที่ putJson เขียน มีช่องว่างหลัง colon)
json_num() { # json_num <ไฟล์> <key>
  grep -Eo "\"$2\"[[:space:]]*:[[:space:]]*[0-9]+" "$1" 2>/dev/null |
    head -1 | grep -Eo '[0-9]+$' || true
}

ok()   { PASS=$((PASS+1)); RESULTS+=("PASS | $1"); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); RESULTS+=("FAIL | $1 — $2"); printf '  \033[31m✗\033[0m %s\n      %s\n' "$1" "$2"; }

check_eq() { # check_eq <ชื่อเคส> <ค่าที่ได้> <ค่าที่คาด>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "ได้ '$2' คาดหวัง '$3'"; fi
}

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

# ── 0. ตรวจความพร้อมของ stack ────────────────────────────────────────────────

mkdir -p "$ARTIFACT_DIR"
step "0. ตรวจความพร้อมของ stack"

if ! curl -fsS "$BASE_URL/health" >"$ARTIFACT_DIR/health.json" 2>/dev/null; then
  echo "app ที่ $BASE_URL ยังไม่พร้อม — รัน 'docker compose up -d --build' ก่อน" >&2
  exit 1
fi
ok "app healthy ที่ $BASE_URL"

if mc_exec ls "local/$BUCKET" >/dev/null 2>&1; then
  ok "bucket '$BUCKET' พร้อมใช้งาน"
else
  # alias อาจยังไม่ถูกตั้งใน container นี้ (minio-init ตั้งไว้ใน container ของมันเอง)
  mc_exec alias set local http://localhost:9000 minioadmin minioadmin >/dev/null
  if mc_exec ls "local/$BUCKET" >/dev/null 2>&1; then
    ok "bucket '$BUCKET' พร้อมใช้งาน (ตั้ง alias ใหม่)"
  else
    bad "bucket '$BUCKET' พร้อมใช้งาน" "ไม่พบ bucket"; exit 1
  fi
fi

TARGET_MONTH=$(psql_q "SELECT to_char(now() - INTERVAL '7 months', 'YYYY-MM')")
CURRENT_MONTH=$(psql_q "SELECT to_char(now(), 'YYYY-MM')")
OBJ_KEY="log-days/${TARGET_MONTH:0:4}/${TARGET_MONTH:5:2}/log-days-${TARGET_MONTH}.csv.gz"
META_KEY="${OBJ_KEY%.csv.gz}.meta.json"
echo "  เดือนเป้าหมาย: $TARGET_MONTH   เดือนปัจจุบัน: $CURRENT_MONTH"

# ── cleanup ก่อนเริ่ม (idempotent) ───────────────────────────────────────────

cleanup_test_data() {
  psql_run "DELETE FROM \"LogDays\" WHERE serial LIKE '${SERIAL_PREFIX}%'"
  psql_run "DELETE FROM \"LogDayArchive\" WHERE serial LIKE '${SERIAL_PREFIX}%'"
  psql_run "DELETE FROM \"Devices\" WHERE serial LIKE '${SERIAL_PREFIX}%'"
  psql_run "DELETE FROM \"ArchiveExport\" WHERE month = DATE '${TARGET_MONTH}-01'"
  psql_run "DELETE FROM \"ArchiveRestore\" WHERE month = DATE '${TARGET_MONTH}-01'"
  mc_exec rm --recursive --force "local/$BUCKET/log-days/" >/dev/null 2>&1 || true
}
cleanup_test_data

# ── 1. ปิด retention policy ชั่วคราว ─────────────────────────────────────────

step "1. ปิด retention policy ของ LogDays ชั่วคราว"
# ถ้าไม่ปิด background job จะ drop chunk เดือน M-7 ทิ้งก่อนเราได้ export
psql_run "SELECT remove_retention_policy('\"LogDays\"', if_exists => true)"
POLICY_COUNT=$(psql_q "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention' AND hypertable_name = 'LogDays'")
check_eq "retention policy ถูกปิดแล้ว" "$POLICY_COUNT" "0"

# คืน policy กลับเสมอ ไม่ว่าสคริปต์จะจบยังไง — DB ต้องไม่ค้างสภาพผิดปกติ
restore_policy() {
  psql_run "SELECT add_retention_policy('\"LogDays\"', INTERVAL '6 months', if_not_exists => true)" || true
}
trap 'restore_policy' EXIT

# ── 2. seed ข้อมูลเดือน M-7 ──────────────────────────────────────────────────

step "2. seed device + $ROWS log rows ในเดือน $TARGET_MONTH"

psql_run "INSERT INTO \"Devices\" (id, serial, ward, \"staticName\", name, status, seq, firmware, online)
          VALUES (gen_random_uuid()::text, '$SERIAL', 'BK-WARD', 'backup-test', 'backup test device', true, 1, 'v1.0.0', false)"

# กระจาย sendTime ให้ทั่วเดือน (คร่อมหลาย chunk) และให้ค่า temp เป็น deterministic
# เพื่อเอา sum(temp) ไปเทียบหลัง restore ได้ว่าข้อมูลตรงจริง ไม่ใช่แค่จำนวนแถวตรง
psql_run "INSERT INTO \"LogDays\" (id, serial, temp, \"tempDisplay\", humidity, \"humidityDisplay\", \"sendTime\", probe, battery, \"tempInternal\")
          SELECT gen_random_uuid()::text,
                 '$SERIAL',
                 (i % 400) / 10.0,
                 (i % 400) / 10.0,
                 40 + (i % 200) / 10.0,
                 40 + (i % 200) / 10.0,
                 DATE '${TARGET_MONTH}-01' + (i * INTERVAL '8 minutes'),
                 '1', i % 100, 25.5
          FROM generate_series(1, $ROWS) AS i
          WHERE DATE '${TARGET_MONTH}-01' + (i * INTERVAL '8 minutes') < DATE '${TARGET_MONTH}-01' + INTERVAL '1 month'"

SEEDED=$(psql_q "SELECT count(*) FROM \"LogDays\" WHERE serial = '$SERIAL'")
SEED_SUM=$(psql_q "SELECT COALESCE(sum(temp), 0)::numeric(20,4) FROM \"LogDays\" WHERE serial = '$SERIAL'")
SEED_MIN=$(psql_q "SELECT min(\"sendTime\") FROM \"LogDays\" WHERE serial = '$SERIAL'")
SEED_MAX=$(psql_q "SELECT max(\"sendTime\") FROM \"LogDays\" WHERE serial = '$SERIAL'")

if [[ "$SEEDED" -gt 0 ]]; then ok "seed สำเร็จ: $SEEDED rows (sum(temp)=$SEED_SUM)"; else bad "seed สำเร็จ" "0 rows"; exit 1; fi

# ── 3-6. export ──────────────────────────────────────────────────────────────

step "3. POST /backup/exports/$TARGET_MONTH"

EXPORT_START=$(date +%s)
CODE=$(http_code POST "/backup/exports/$TARGET_MONTH")
EXPORT_SECS=$(( $(date +%s) - EXPORT_START ))
cp "$ARTIFACT_DIR/last-body.json" "$ARTIFACT_DIR/03-export.json"

if [[ "$CODE" == "201" || "$CODE" == "200" ]]; then ok "export คืน $CODE"; else bad "export คืน 2xx" "ได้ $CODE: $(cat "$ARTIFACT_DIR/03-export.json")"; fi

EXPORT_ROWS=$(json_num "$ARTIFACT_DIR/03-export.json" rowCount)
EXPORT_SHA=$(grep -o '"sha256":"[a-f0-9]*"' "$ARTIFACT_DIR/03-export.json" | head -1 | cut -d'"' -f4)
check_eq "export rowCount ตรงกับที่ seed" "$EXPORT_ROWS" "$SEEDED"
if [[ -n "$EXPORT_SHA" ]]; then ok "export คืน sha256 (${EXPORT_SHA:0:16}…)"; else bad "export คืน sha256" "ไม่มีใน response"; fi
echo "  ใช้เวลา ${EXPORT_SECS}s"

step "4. ตรวจ artifact บน object storage"

if mc_exec stat "local/$BUCKET/$OBJ_KEY" >"$ARTIFACT_DIR/04-stat.txt" 2>&1; then
  ok "พบไฟล์ $OBJ_KEY"
else
  bad "พบไฟล์ $OBJ_KEY" "$(cat "$ARTIFACT_DIR/04-stat.txt")"
fi

OBJ_SIZE=$(mc_exec stat --json "local/$BUCKET/$OBJ_KEY" 2>/dev/null | grep -o '"size":[0-9]*' | head -1 | cut -d: -f2 || echo 0)
if [[ "${OBJ_SIZE:-0}" -gt 0 ]]; then ok "ขนาดไฟล์ $OBJ_SIZE bytes"; else bad "ขนาดไฟล์ > 0" "ได้ $OBJ_SIZE"; fi

mc_exec cat "local/$BUCKET/$META_KEY" >"$ARTIFACT_DIR/04-meta.json" 2>/dev/null || true
META_ROWS=$(json_num "$ARTIFACT_DIR/04-meta.json" rowCount)
check_eq "meta.json rowCount ตรงกับ export" "$META_ROWS" "$SEEDED"

step "5. ตรวจ integrity ของ gzip stream"

# แตก gzip แล้วนับบรรทัด — ต้องได้ rows + 1 (header)
GZ_LINES=$(mc_exec cat "local/$BUCKET/$OBJ_KEY" | gunzip | wc -l | tr -d ' ')
check_eq "gunzip นับบรรทัดได้ $((SEEDED + 1)) (รวม header)" "$GZ_LINES" "$((SEEDED + 1))"

step "6. ตรวจตาราง ArchiveExport"
EXPORT_ROW=$(psql_q "SELECT count(*) FROM \"ArchiveExport\" WHERE month = DATE '${TARGET_MONTH}-01'")
check_eq "ArchiveExport มี 1 แถวของเดือนนี้" "$EXPORT_ROW" "1"

# ── 7. จำลอง retention drop ──────────────────────────────────────────────────

step "7. จำลอง retention drop (ลบข้อมูลออกจาก LogDays)"
psql_run "DELETE FROM \"LogDays\" WHERE serial = '$SERIAL'"
AFTER_DROP=$(psql_q "SELECT count(*) FROM \"LogDaysAll\" WHERE serial = '$SERIAL'")
check_eq "LogDaysAll ว่างแล้ว (ข้อมูลหายจริง)" "$AFTER_DROP" "0"

# ── 8-11. restore ────────────────────────────────────────────────────────────

step "8. POST /backup/restores/$TARGET_MONTH"

RESTORE_START=$(date +%s)
CODE=$(http_code POST "/backup/restores/$TARGET_MONTH")
RESTORE_SECS=$(( $(date +%s) - RESTORE_START ))
cp "$ARTIFACT_DIR/last-body.json" "$ARTIFACT_DIR/08-restore.json"

if [[ "$CODE" == "201" || "$CODE" == "200" ]]; then ok "restore คืน $CODE"; else bad "restore คืน 2xx" "ได้ $CODE: $(cat "$ARTIFACT_DIR/08-restore.json")"; fi
RESTORE_ROWS=$(json_num "$ARTIFACT_DIR/08-restore.json" rowCount)
check_eq "restore rowCount ตรงกับที่ export" "$RESTORE_ROWS" "$SEEDED"
echo "  ใช้เวลา ${RESTORE_SECS}s"

step "9. เทียบข้อมูลหลัง restore กับต้นฉบับ"
# เทียบมากกว่าจำนวนแถว — ค่าจริงต้องตรงด้วย ไม่งั้น restore ที่ 'ผ่าน' อาจได้ข้อมูลเพี้ยน
GOT_COUNT=$(psql_q "SELECT count(*) FROM \"LogDayArchive\" WHERE serial = '$SERIAL'")
GOT_SUM=$(psql_q "SELECT COALESCE(sum(temp), 0)::numeric(20,4) FROM \"LogDayArchive\" WHERE serial = '$SERIAL'")
GOT_MIN=$(psql_q "SELECT min(\"sendTime\") FROM \"LogDayArchive\" WHERE serial = '$SERIAL'")
GOT_MAX=$(psql_q "SELECT max(\"sendTime\") FROM \"LogDayArchive\" WHERE serial = '$SERIAL'")

check_eq "count ตรง" "$GOT_COUNT" "$SEEDED"
check_eq "sum(temp) ตรง" "$GOT_SUM" "$SEED_SUM"
check_eq "min(sendTime) ตรง" "$GOT_MIN" "$SEED_MIN"
check_eq "max(sendTime) ตรง" "$GOT_MAX" "$SEED_MAX"

step "10. ตรวจ view LogDaysAll"
ALL_COUNT=$(psql_q "SELECT count(*) FROM \"LogDaysAll\" WHERE serial = '$SERIAL'")
check_eq "LogDaysAll คืนข้อมูลครบ ไม่ซ้ำ" "$ALL_COUNT" "$SEEDED"

step "11. GET /backup/months"
curl -fsS "$BASE_URL/backup/months" >"$ARTIFACT_DIR/11-months.json"
if grep -q "\"month\":\"$TARGET_MONTH\"" "$ARTIFACT_DIR/11-months.json" &&
   grep -q '"restored":true' "$ARTIFACT_DIR/11-months.json"; then
  ok "months แสดงเดือน $TARGET_MONTH เป็น restored: true"
else
  bad "months แสดง restored: true" "$(cat "$ARTIFACT_DIR/11-months.json")"
fi

# ── 12-15. guard ─────────────────────────────────────────────────────────────

step "12-15. ตรวจ guard ต่าง ๆ"

CODE=$(http_code POST "/backup/restores/$TARGET_MONTH")
check_eq "restore ซ้ำ → 409 Conflict" "$CODE" "409"

CODE=$(http_code POST "/backup/restores/$CURRENT_MONTH")
check_eq "restore เดือนปัจจุบัน → 400 (retention window)" "$CODE" "400"

CODE=$(http_code POST "/backup/restores/2020-01")
check_eq "restore เดือนที่ไม่มี backup → 404" "$CODE" "404"

CODE=$(http_code POST "/backup/restores/2020-13")
check_eq "restore เดือน 13 → 400" "$CODE" "400"

CODE=$(http_code POST "/backup/restores/abc")
check_eq "restore เดือนรูปแบบผิด → 400" "$CODE" "400"

# ── 16. rollback path (เคสสำคัญที่ unit test พิสูจน์ไม่ได้) ──────────────────

step "16. rollback เมื่อ rowCount ไม่ตรงกับ meta"

# unit test mock pg.Pool ไว้ จึงพิสูจน์ไม่ได้ว่า ROLLBACK จริงทำงาน — ต้องทดสอบตรงนี้
mc_exec cp "local/$BUCKET/$OBJ_KEY" "local/$BUCKET/${OBJ_KEY}.bak" >/dev/null
# ตัด 10 แถวท้ายออกแล้วอัดกลับ → rowCount จะไม่ตรงกับ meta.json
mc_exec cat "local/$BUCKET/$OBJ_KEY" | gunzip | head -n "$((SEEDED + 1 - 10))" | gzip >"$ARTIFACT_DIR/16-truncated.csv.gz"
docker compose cp "$ARTIFACT_DIR/16-truncated.csv.gz" minio:/tmp/truncated.csv.gz >/dev/null
mc_exec cp /tmp/truncated.csv.gz "local/$BUCKET/$OBJ_KEY" >/dev/null

# เคลียร์สภาพให้ restore ใหม่ได้
psql_run "DELETE FROM \"LogDayArchive\" WHERE serial = '$SERIAL'"
psql_run "DELETE FROM \"ArchiveRestore\" WHERE month = DATE '${TARGET_MONTH}-01'"

CODE=$(http_code POST "/backup/restores/$TARGET_MONTH")
cp "$ARTIFACT_DIR/last-body.json" "$ARTIFACT_DIR/16-mismatch.json"
if [[ "$CODE" == "500" ]]; then ok "restore ไฟล์เพี้ยน → 500"; else bad "restore ไฟล์เพี้ยน → 500" "ได้ $CODE"; fi

LEFTOVER=$(psql_q "SELECT count(*) FROM \"LogDayArchive\" WHERE serial = '$SERIAL'")
check_eq "ROLLBACK ครบ — ไม่มีข้อมูลค้างใน LogDayArchive" "$LEFTOVER" "0"

LEFTOVER_AUDIT=$(psql_q "SELECT count(*) FROM \"ArchiveRestore\" WHERE month = DATE '${TARGET_MONTH}-01'")
check_eq "ROLLBACK ครบ — ไม่มี audit row ค้าง" "$LEFTOVER_AUDIT" "0"

# คืนไฟล์ดีกลับ แล้ว restore ใหม่ให้สำเร็จ เพื่อทดสอบ DELETE ต่อ
mc_exec cp "local/$BUCKET/${OBJ_KEY}.bak" "local/$BUCKET/$OBJ_KEY" >/dev/null
mc_exec rm "local/$BUCKET/${OBJ_KEY}.bak" >/dev/null
CODE=$(http_code POST "/backup/restores/$TARGET_MONTH")
if [[ "$CODE" == "201" || "$CODE" == "200" ]]; then ok "restore ไฟล์ดีหลัง rollback สำเร็จ"; else bad "restore หลัง rollback" "ได้ $CODE"; fi

# ── 17-18. remove ────────────────────────────────────────────────────────────

step "17-18. DELETE /backup/restores/$TARGET_MONTH"

CODE=$(http_code DELETE "/backup/restores/$TARGET_MONTH")
cp "$ARTIFACT_DIR/last-body.json" "$ARTIFACT_DIR/17-remove.json"
check_eq "remove คืน 200" "$CODE" "200"
REMOVED=$(json_num "$ARTIFACT_DIR/17-remove.json" removedRows)
check_eq "removedRows ตรงกับที่ restore" "$REMOVED" "$SEEDED"

AFTER_REMOVE=$(psql_q "SELECT count(*) FROM \"LogDayArchive\" WHERE serial = '$SERIAL'")
check_eq "LogDayArchive ว่างแล้ว" "$AFTER_REMOVE" "0"

if mc_exec stat "local/$BUCKET/$OBJ_KEY" >/dev/null 2>&1; then
  ok "ไฟล์บน object storage ยังอยู่ (remove ไม่แตะ archive)"
else
  bad "ไฟล์บน object storage ยังอยู่" "ไฟล์หายไป"
fi

CODE=$(http_code DELETE "/backup/restores/$TARGET_MONTH")
check_eq "remove ซ้ำ → 404" "$CODE" "404"

# ── 19-20. edge case ของ export ──────────────────────────────────────────────

step "19-20. edge case ของ export"

EMPTY_MONTH=$(psql_q "SELECT to_char(now() - INTERVAL '25 months', 'YYYY-MM')")
CODE=$(http_code POST "/backup/exports/$EMPTY_MONTH")
cp "$ARTIFACT_DIR/last-body.json" "$ARTIFACT_DIR/19-empty.json"
if [[ "$CODE" == "201" || "$CODE" == "200" ]]; then ok "export เดือนที่ไม่มีข้อมูล → $CODE ไม่ throw"; else bad "export เดือนว่าง" "ได้ $CODE"; fi
EMPTY_ROWS=$(json_num "$ARTIFACT_DIR/19-empty.json" rowCount)
check_eq "export เดือนว่างคืน rowCount 0" "$EMPTY_ROWS" "0"

CODE=$(http_code POST "/backup/exports/$TARGET_MONTH")
if [[ "$CODE" == "201" || "$CODE" == "200" ]]; then ok "export เดือนเดิมซ้ำ → $CODE (upsert)"; else bad "export ซ้ำ" "ได้ $CODE"; fi

# ── 21. MinIO ล่ม ────────────────────────────────────────────────────────────

step "21. พฤติกรรมเมื่อ object storage ล่ม"

CONN_BEFORE=$(psql_q "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'smtrack-log-archive'")
docker compose stop minio >/dev/null 2>&1

psql_run "DELETE FROM \"ArchiveRestore\" WHERE month = DATE '${TARGET_MONTH}-01'"
CODE=$(http_code POST "/backup/restores/$TARGET_MONTH")
cp "$ARTIFACT_DIR/last-body.json" "$ARTIFACT_DIR/21-minio-down.json"
if [[ "$CODE" =~ ^(404|500|503)$ ]]; then ok "restore ตอน MinIO ล่ม → $CODE (ไม่ค้าง)"; else bad "restore ตอน MinIO ล่ม" "ได้ $CODE"; fi

docker compose start minio >/dev/null 2>&1
sleep 5
CONN_AFTER=$(psql_q "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'smtrack-log-archive'")
if [[ "$CONN_AFTER" -le "$CONN_BEFORE" ]]; then
  ok "pg pool ไม่รั่ว (before=$CONN_BEFORE after=$CONN_AFTER)"
else
  bad "pg pool ไม่รั่ว" "before=$CONN_BEFORE after=$CONN_AFTER"
fi

# ── 22. คืนสภาพ ──────────────────────────────────────────────────────────────

step "22. คืนสภาพฐานข้อมูล"

cleanup_test_data
restore_policy
trap - EXIT

POLICY_BACK=$(psql_q "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention' AND hypertable_name = 'LogDays'")
check_eq "retention policy กลับมาแล้ว" "$POLICY_BACK" "1"
RESIDUE=$(psql_q "SELECT count(*) FROM \"LogDaysAll\" WHERE serial LIKE '${SERIAL_PREFIX}%'")
check_eq "ไม่มีข้อมูลทดสอบตกค้าง" "$RESIDUE" "0"

# ── สรุป ─────────────────────────────────────────────────────────────────────

{
  echo "# ผลทดสอบ backup/restore — $(date '+%Y-%m-%d %H:%M:%S')"
  echo
  echo "เดือนเป้าหมาย: $TARGET_MONTH | rows: $SEEDED | ขนาด archive: $OBJ_SIZE bytes"
  echo "export: ${EXPORT_SECS}s | restore: ${RESTORE_SECS}s | sha256: $EXPORT_SHA"
  echo
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "PASS=$PASS FAIL=$FAIL"
} >"$ARTIFACT_DIR/summary.txt"

printf '\n\033[1m═══ สรุป ═══\033[0m\n'
printf '  PASS: \033[32m%d\033[0m   FAIL: \033[31m%d\033[0m\n' "$PASS" "$FAIL"
printf '  รายละเอียด: %s/summary.txt\n\n' "$ARTIFACT_DIR"

[[ "$FAIL" -eq 0 ]]
