import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { Metadata } from '@grpc/grpc-js';
import { PartnerApiKeyContext, PartnerApiKeyService } from './partner-api-key.service';

export const API_KEY_METADATA_KEY = 'x-api-key';

/** ผูก apiKey context ไว้ที่ตัว RPC data object เอง — gRPC ไม่มี request object ให้แปะเหมือน HTTP */
export interface WithPartnerApiKey {
  __partnerApiKey?: PartnerApiKeyContext;
}

function readApiKey(metadata: Metadata): string | undefined {
  const value = metadata.get(API_KEY_METADATA_KEY)[0];
  return typeof value === 'string' ? value : value?.toString('utf-8');
}

/**
 * Auth guard ของ Partner gRPC surface — เทียบเท่า ApiKeyAuthGuard เดิมฝั่ง REST แต่อ่าน
 * key จาก gRPC metadata (`x-api-key`) แทน header เพราะ gRPC ไม่มี HTTP header
 *
 * context.switchToRpc().getContext() สำหรับ transport GRPC ของ @nestjs/microservices
 * คืนค่าเป็น grpc.Metadata ตรง ๆ (อาร์กิวเมนต์ตัวที่ 2 ของ handler ตาม @GrpcMethod)
 */
@Injectable()
export class GrpcApiKeyAuthGuard implements CanActivate {
  constructor(private readonly partnerApiKeyService: PartnerApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rpc = context.switchToRpc();
    const metadata = rpc.getContext<Metadata>();
    const rawKey = readApiKey(metadata);
    if (!rawKey) {
      throw new RpcException({
        code: status.UNAUTHENTICATED,
        message: 'Missing x-api-key metadata',
      });
    }

    const apiKey = await this.partnerApiKeyService.validate(rawKey);
    if (!apiKey) {
      throw new RpcException({
        code: status.UNAUTHENTICATED,
        message: 'Invalid or revoked API key',
      });
    }

    (rpc.getData() as WithPartnerApiKey).__partnerApiKey = apiKey;
    return true;
  }
}
