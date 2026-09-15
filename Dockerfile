FROM --platform=linux/amd64 node:24-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── builder ───────────────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app
COPY tsconfig*.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY test ./test
COPY src ./src
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    npx prisma generate && npm run build

# ── migrate ───────────────────────────────────────────────────────────────────
FROM builder AS migrate

# ── runner ────────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache curl \
  && addgroup -S nodejs && adduser -S nestjs -G nodejs \
  && chown nestjs:nodejs /app

USER nestjs

COPY --chown=nestjs:nodejs package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=nestjs:nodejs --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/main"]
