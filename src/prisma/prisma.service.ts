import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    // Prisma 7 เป็น Rust-free — ต้องต่อ DB ผ่าน driver adapter (pg) เสมอ
    super({
      adapter: new PrismaPg({
        connectionString: config.get<string>('databaseUrl'),
        // ไม่ตั้งค่านี้ pg จะไม่มี connect timeout เลย (default 0) — ถ้า DB unreachable
        // แบบไม่ refuse ทันที (เช่น firewall drop) $connect() จะค้างตลอดไปและทำให้
        // NestFactory.create() ไม่ resolve → bootstrap ค้างเงียบไม่มี log เลย
        connectionTimeoutMillis: 10_000,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }
}
