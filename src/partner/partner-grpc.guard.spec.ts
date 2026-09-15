import { ExecutionContext } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { GrpcApiKeyAuthGuard, WithPartnerApiKey } from './partner-grpc.guard';
import { PartnerApiKeyContext, PartnerApiKeyService } from './partner-api-key.service';

function makeContext(metadataValue: string | undefined, data: WithPartnerApiKey = {}) {
  const metadata = {
    get: (key: string) => (key === 'x-api-key' && metadataValue ? [metadataValue] : []),
  };
  return {
    switchToRpc: () => ({
      getContext: () => metadata,
      getData: () => data,
    }),
  } as unknown as ExecutionContext;
}

describe('GrpcApiKeyAuthGuard', () => {
  let guard: GrpcApiKeyAuthGuard;
  let partnerApiKeyService: { validate: jest.Mock };

  beforeEach(() => {
    partnerApiKeyService = { validate: jest.fn() };
    guard = new GrpcApiKeyAuthGuard(partnerApiKeyService as unknown as PartnerApiKeyService);
  });

  it('throws UNAUTHENTICATED when the x-api-key metadata is missing', async () => {
    const context = makeContext(undefined);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(RpcException);
    try {
      await guard.canActivate(context);
    } catch (err) {
      expect((err as RpcException).getError()).toMatchObject({ code: status.UNAUTHENTICATED });
    }
    expect(partnerApiKeyService.validate).not.toHaveBeenCalled();
  });

  it('throws UNAUTHENTICATED when the key is invalid or revoked', async () => {
    partnerApiKeyService.validate.mockResolvedValue(null);
    const context = makeContext('pk_live_bogus');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(RpcException);
  });

  it('attaches the resolved key context onto the request data and allows the call', async () => {
    const apiKey: PartnerApiKeyContext = { id: 'key-1', name: 'Acme', wards: new Set(['ICU']) };
    partnerApiKeyService.validate.mockResolvedValue(apiKey);
    const data: WithPartnerApiKey = {};
    const context = makeContext('pk_live_valid', data);

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(data.__partnerApiKey).toBe(apiKey);
  });
});
