import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { PartnerApiKeyService } from './partner-api-key.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PartnerApiKeyService', () => {
  let service: PartnerApiKeyService;
  let prisma: {
    partnerApiKeys: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      partnerApiKeys: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    service = new PartnerApiKeyService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('returns the plaintext key once and stores only its SHA-256 hash', async () => {
      prisma.partnerApiKeys.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'key-1',
          name: data.name,
          keyHash: data.keyHash,
          keyPrefix: data.keyPrefix,
          createAt: new Date('2026-01-01'),
          tenants: [{ tenantId: 'ICU' }, { tenantId: 'OPD' }],
        }),
      );

      const result = await service.create({ name: 'Acme', tenantIds: ['ICU', 'OPD'] });

      expect(result.apiKey).toMatch(/^pk_live_/);
      expect(result.tenantIds).toEqual(['ICU', 'OPD']);

      const [[createArgs]] = prisma.partnerApiKeys.create.mock.calls;
      const expectedHash = createHash('sha256').update(result.apiKey).digest('hex');
      expect(createArgs.data.keyHash).toBe(expectedHash);
      // hash เท่านั้นที่ถูกส่งเข้า DB — plaintext ไม่ปรากฏใน payload ที่จะถูกเก็บ
      expect(JSON.stringify(createArgs.data)).not.toContain(result.apiKey);
    });
  });

  describe('validate', () => {
    it('returns null when no key matches the hash', async () => {
      prisma.partnerApiKeys.findUnique.mockResolvedValue(null);
      await expect(service.validate('pk_live_bogus')).resolves.toBeNull();
    });

    it('returns null when the matching key has been revoked', async () => {
      prisma.partnerApiKeys.findUnique.mockResolvedValue({
        id: 'key-1',
        name: 'Acme',
        revokedAt: new Date('2026-02-01'),
        tenants: [{ tenantId: 'ICU' }],
      });
      await expect(service.validate('pk_live_whatever')).resolves.toBeNull();
    });

    it('returns the key context (with allowlisted tenants) when valid and active', async () => {
      prisma.partnerApiKeys.findUnique.mockResolvedValue({
        id: 'key-1',
        name: 'Acme',
        revokedAt: null,
        tenants: [{ tenantId: 'ICU' }, { tenantId: 'OPD' }],
      });

      const context = await service.validate('pk_live_whatever');

      expect(context).toEqual({ id: 'key-1', name: 'Acme', tenants: new Set(['ICU', 'OPD']) });
    });
  });

  describe('revoke', () => {
    it('throws NotFoundException for an unknown key id', async () => {
      prisma.partnerApiKeys.findUnique.mockResolvedValue(null);
      await expect(service.revoke('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
