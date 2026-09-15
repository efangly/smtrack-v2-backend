import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { RedisService } from '../redis/redis.service';
import { WithPartnerApiKey } from './partner-grpc.guard';

const WINDOW_SECONDS = 60;
const LIMIT_PER_WINDOW = 60;

/**
 * Rate limit ต่อ Partner API Key (60 req/min) — @nestjs/throttler ผูกกับ HTTP adapter
 * เท่านั้น ใช้กับ gRPC ไม่ได้ จึงเขียน guard เองบน RedisService.incrementWithExpiry
 *
 * ต้องมาหลัง GrpcApiKeyAuthGuard เสมอใน @UseGuards() — ต้องมี __partnerApiKey ให้ track
 */
@Injectable()
export class GrpcPartnerRateLimitGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const data = context.switchToRpc().getData() as WithPartnerApiKey;
    const keyId = data.__partnerApiKey?.id ?? 'unknown';

    const bucket = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
    const count = await this.redis.incrementWithExpiry(
      `partner-grpc-ratelimit:${keyId}:${bucket}`,
      WINDOW_SECONDS,
    );

    if (count > LIMIT_PER_WINDOW) {
      throw new RpcException({
        code: status.RESOURCE_EXHAUSTED,
        message: `Rate limit exceeded — max ${LIMIT_PER_WINDOW} requests/minute`,
      });
    }
    return true;
  }
}
