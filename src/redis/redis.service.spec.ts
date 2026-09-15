import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

describe('RedisService.incrementWithExpiry', () => {
  let service: RedisService;
  let client: { incr: jest.Mock; expire: jest.Mock };

  beforeEach(() => {
    service = new RedisService({} as ConfigService);
    client = { incr: jest.fn(), expire: jest.fn() };
    // ไม่เรียก onModuleInit() (จะพยายามต่อ Redis จริง) — แปะ mock client ตรงเข้า field
    // private แทน เหมือน pattern ทดสอบ service ที่ lazy-connect อื่น ๆ ในโปรเจคนี้
    (service as unknown as { client: unknown }).client = client;
  });

  it('sets a TTL only on the first increment (count === 1)', async () => {
    client.incr.mockResolvedValue(1);

    const count = await service.incrementWithExpiry('rl:key-1:0', 60);

    expect(count).toBe(1);
    expect(client.expire).toHaveBeenCalledWith('rl:key-1:0', 60);
  });

  it('does not re-set the TTL on subsequent increments', async () => {
    client.incr.mockResolvedValue(2);

    const count = await service.incrementWithExpiry('rl:key-1:0', 60);

    expect(count).toBe(2);
    expect(client.expire).not.toHaveBeenCalled();
  });

  it('fails open (returns 0) if Redis errors, instead of throwing', async () => {
    client.incr.mockRejectedValue(new Error('connection lost'));

    await expect(service.incrementWithExpiry('rl:key-1:0', 60)).resolves.toBe(0);
  });
});
