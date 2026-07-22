
# ติดตั้ง dependency ทั้งหมด (รวม devDeps) ไว้ใช้ทั้ง build และ stage migrate
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── builder ───────────────────────────────────────────────────────────────────
# generate Prisma client ก่อนเสมอ — Prisma 7 emit ลง src/generated/prisma ซึ่ง gitignore ไว้
# ถ้าไม่ generate ก่อน nest build จะพังตรง prisma.service.ts ที่ import จาก path นั้น
FROM deps AS builder
WORKDIR /app
COPY tsconfig*.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY test ./test
COPY src ./src
# prisma.config.ts เรียก env('DATABASE_URL') ตอนโหลด config เลย จึงต้องมีค่าหลอกไว้ตอน build
# (generate ไม่ได้ต่อ DB จริง ค่านี้ไม่ถูกใช้ — ค่าจริงมาจาก compose ตอน runtime)
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    npx prisma generate && npm run build

# ── migrate ───────────────────────────────────────────────────────────────────
# image สำหรับ job แบบ one-shot: prisma migrate deploy / db seed
# ต้องใช้ builder เพราะ prisma CLI + ts-node + prisma.config.ts เป็น devDeps ทั้งหมด
FROM builder AS migrate

# ── runner ────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# prod deps เท่านั้น — Prisma 7 เป็น Rust-free ไม่ต้องมี engine binary ติดมาด้วย
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# nest build คอมไพล์ src/generated/prisma ไปเป็น dist/generated/prisma ให้แล้ว
COPY --from=builder /app/dist ./dist

# curl ไว้ให้ healthcheck ใน compose ใช้
RUN apk add --no-cache curl \
  && addgroup -S nodejs && adduser -S nestjs -G nodejs \
  && chown -R nestjs:nodejs /app
USER nestjs

EXPOSE 3000
CMD ["node", "dist/main"]
