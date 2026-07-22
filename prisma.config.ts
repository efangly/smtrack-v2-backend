import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7: env ไม่ถูกโหลดอัตโนมัติ + url ย้ายออกจาก datasource block มาที่นี่
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // Prisma 7: seed command ย้ายมาอยู่ที่นี่ ไม่ใช่ key "prisma.seed" ใน package.json แล้ว
    seed: 'ts-node prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
