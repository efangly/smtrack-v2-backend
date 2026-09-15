import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/** Cache layer — wrap ioredis client พร้อม get/set/del และ cache-aside helper (getOrSet) */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client?: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.get<string>('redisUrl')!;
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));
    void this.client
      .connect()
      .catch((err) => this.logger.warn(`Redis connect failed: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit();
  }

  async get(key: string): Promise<string | null> {
    return this.client?.get(key) ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.client) return;
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client?.del(key);
    } catch (err) {
      this.logger.warn(`Redis del failed for ${key}: ${this.msg(err)}`);
    }
  }

  /** ลบ key ทั้งหมดที่ match pattern ด้วย SCAN (ไม่ใช้ KEYS เพราะ block Redis) */
  async delByPattern(pattern: string): Promise<void> {
    if (!this.client) return;
    try {
      const stream = this.client.scanStream({ match: pattern, count: 100 });
      for await (const keys of stream as AsyncIterable<string[]>) {
        if (keys.length) await this.client.del(...keys);
      }
    } catch (err) {
      this.logger.warn(`Redis delByPattern failed for ${pattern}: ${this.msg(err)}`);
    }
  }

  /** cache-aside: cache hit คืนค่าจาก Redis, miss/error เรียก factory() แล้ว best-effort เขียนกลับ cache */
  async getOrSet<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    try {
      const cached = await this.get(key);
      if (cached !== null) return JSON.parse(cached) as T;
    } catch (err) {
      this.logger.warn(`Redis get failed for ${key}: ${this.msg(err)}`);
    }

    const value = await factory();

    try {
      await this.set(key, JSON.stringify(value), ttlSeconds);
    } catch (err) {
      this.logger.warn(`Redis set failed for ${key}: ${this.msg(err)}`);
    }

    return value;
  }

  /**
   * INCR แบบ fixed-window rate limit counter — ตั้ง TTL เฉพาะครั้งแรกที่ key ถูกสร้าง (count===1)
   * เท่านั้น ไม่งั้น window จะถูกเลื่อนออกไปทุกครั้งที่มี request ใหม่เข้ามา (ไม่ใช่ fixed window อีกต่อไป)
   * ไม่ใช้ `EXPIRE ... NX` (Redis 7+ เท่านั้น) เพื่อไม่ผูกกับเวอร์ชัน server
   *
   * fail-open: ถ้า Redis ต่อไม่ได้/error คืน 0 (เหมือนยังไม่เคยมี request) แทนการ throw
   * เพื่อไม่ให้ Redis ล่มกลายเป็นบล็อก traffic ของ partner ทั้งหมด (เหมือน getOrSet ข้างบน)
   */
  async incrementWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    if (!this.client) return 0;
    try {
      const count = await this.client.incr(key);
      if (count === 1) {
        await this.client.expire(key, ttlSeconds);
      }
      return count;
    } catch (err) {
      this.logger.warn(`Redis incrementWithExpiry failed for ${key}: ${this.msg(err)}`);
      return 0;
    }
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
