import { ExecutionContext } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { GrpcPartnerRateLimitGuard } from './partner-grpc-rate-limit.guard';
import { RedisService } from '../redis/redis.service';
import { WithPartnerApiKey } from './partner-grpc.guard';

function makeContext(data: WithPartnerApiKey) {
  return {
    switchToRpc: () => ({ getData: () => data }),
  } as unknown as ExecutionContext;
}

describe('GrpcPartnerRateLimitGuard', () => {
  let guard: GrpcPartnerRateLimitGuard;
  let redis: { incrementWithExpiry: jest.Mock };

  beforeEach(() => {
    redis = { incrementWithExpiry: jest.fn() };
    guard = new GrpcPartnerRateLimitGuard(redis as unknown as RedisService);
  });

  it('allows the call when under the limit', async () => {
    redis.incrementWithExpiry.mockResolvedValue(1);
    const context = makeContext({
      __partnerApiKey: { id: 'key-1', name: 'Acme', tenants: new Set() },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('throws RESOURCE_EXHAUSTED once the per-minute limit is exceeded', async () => {
    redis.incrementWithExpiry.mockResolvedValue(61);
    const context = makeContext({
      __partnerApiKey: { id: 'key-1', name: 'Acme', tenants: new Set() },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(RpcException);
    try {
      await guard.canActivate(context);
    } catch (err) {
      expect((err as RpcException).getError()).toMatchObject({ code: status.RESOURCE_EXHAUSTED });
    }
  });

  it('tracks the counter per key id', async () => {
    redis.incrementWithExpiry.mockResolvedValue(1);
    const context = makeContext({
      __partnerApiKey: { id: 'key-42', name: 'Acme', tenants: new Set() },
    });

    await guard.canActivate(context);

    const [[key]] = redis.incrementWithExpiry.mock.calls;
    expect(key).toContain('key-42');
  });
});
