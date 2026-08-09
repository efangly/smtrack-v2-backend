#!/usr/bin/env bash
#
# Deploy observability stack (otel-collector, tempo, loki, prometheus, alloy, grafana)
# บน dev server ที่มี mosquitto/minio/app รันอยู่แล้วผ่าน compose อื่นบน network เดียวกัน
#
#   cp observability/.env.example observability/.env   # แก้ค่าจริงก่อนรันครั้งแรก
#   bash observability/deploy.sh
#
# exit 0 = deploy สำเร็จและทุก service healthy

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_FILE="docker-compose.yml"
ENV_FILE="${ENV_FILE:-.env}"

PASS=0
FAIL=0

ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n      %s\n' "$1" "$2"; }
step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# ── 0. ตรวจไฟล์และ network ที่ต้องมีอยู่ก่อน ─────────────────────────────────

step "0. ตรวจความพร้อมก่อน deploy"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ไม่พบ $ENV_FILE — copy จาก .env.example แล้วแก้ค่าก่อน" >&2
  exit 1
fi
ok "พบ $ENV_FILE"

EXTERNAL_NETWORK=$(grep -E '^EXTERNAL_NETWORK=' "$ENV_FILE" | cut -d= -f2- || true)
EXTERNAL_NETWORK="${EXTERNAL_NETWORK:-proxy}"

if docker network inspect "$EXTERNAL_NETWORK" >/dev/null 2>&1; then
  ok "network '$EXTERNAL_NETWORK' มีอยู่แล้ว (mosquitto/minio/app ควรอยู่บน network นี้)"
else
  echo "ไม่พบ network '$EXTERNAL_NETWORK' — network นี้ควรถูกสร้างโดย compose ของ mosquitto/minio/app อยู่แล้ว ตรวจให้แน่ใจว่า deploy stack หลักก่อน" >&2
  exit 1
fi

# ── 1. pull image ─────────────────────────────────────────────────────────────

step "1. pull image ล่าสุด"
compose pull

# ── 2. up ────────────────────────────────────────────────────────────────────

step "2. docker compose up -d"
compose up -d

# object-storage-init เป็น one-shot job (สร้าง bucket) — เอา container ที่ exit แล้วออก
# ไม่ให้ค้างอยู่ใน `docker ps -a` เหมือนใช้ `docker run --rm`
compose rm -f object-storage-init >/dev/null 2>&1 || true

# ── 3. healthcheck ───────────────────────────────────────────────────────────

step "3. รอ service พร้อมใช้งาน"

wait_http() { # wait_http <ชื่อ> <container> <url ภายใน container network>
  local name="$1" container="$2" url="$3"
  for _ in $(seq 1 30); do
    if compose exec -T "$container" wget -q -O- "$url" >/dev/null 2>&1; then
      ok "$name พร้อมใช้งาน"
      return 0
    fi
    sleep 2
  done
  bad "$name พร้อมใช้งาน" "timeout รอ $url"
}

wait_http "Prometheus" prometheus "http://localhost:9090/-/healthy"
wait_http "Loki" loki "http://localhost:3100/ready"
wait_http "Tempo" tempo "http://localhost:3200/ready"

if curl -fsS "http://127.0.0.1:3001/api/health" >/dev/null 2>&1; then
  ok "Grafana พร้อมใช้งาน"
else
  bad "Grafana พร้อมใช้งาน" "curl http://127.0.0.1:3001/api/health ไม่ผ่าน"
fi

# ── สรุป ─────────────────────────────────────────────────────────────────────

printf '\n\033[1m═══ สรุป ═══\033[0m\n'
printf '  PASS: \033[32m%d\033[0m   FAIL: \033[31m%d\033[0m\n\n' "$PASS" "$FAIL"

if [[ "$FAIL" -eq 0 ]]; then
  cat <<'EOF'
Grafana: http://<dev-server-ip>:3001

ขั้นต่อไป: ตั้ง OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 ใน env ของ service
`app` (compose หลักที่รันอยู่แล้ว) แล้ว restart app เพื่อให้ trace/metric เริ่มไหลเข้า
(script นี้ไม่แตะ compose ของ app โดยตรง)
EOF
fi

[[ "$FAIL" -eq 0 ]]
