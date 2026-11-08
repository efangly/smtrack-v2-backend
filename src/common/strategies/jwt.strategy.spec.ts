import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  const strategy = new JwtStrategy({ get: () => 'test-secret' } as unknown as ConfigService);

  const claims = {
    id: 'u1',
    name: 'user',
    role: 'USER',
    tenantId: 't1',
    departmentIds: ['OPD', 'ICU'],
    typ: 'access',
  };

  it('แปลง claim ของ auth-service เป็น scope — ไม่ส่ง tenantId/departmentIds ดิบต่อ', async () => {
    await expect(strategy.validate(claims)).resolves.toEqual({
      id: 'u1',
      name: 'user',
      role: 'USER',
      scope: { kind: 'TENANT', tenantId: 't1', departments: ['OPD', 'ICU'] },
    });
  });

  it.each([
    ['ไม่มี typ', { ...claims, typ: undefined }],
    ['refresh token', { ...claims, typ: 'refresh' }],
  ])('ปฏิเสธ token ที่ไม่ใช่ access token (%s)', async (_label, payload) => {
    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('ปฏิเสธ token ของ role ที่ต้องมี tenant แต่ไม่มี tenantId (ไม่ใช่ให้เห็นทุกอย่าง)', async () => {
    await expect(
      strategy.validate({ ...claims, role: 'ADMIN', tenantId: undefined }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('token เก่าแบบ wardId ไม่มี tenant จึงถูกปฏิเสธ', async () => {
    const legacy = { id: 'u1', name: 'user', role: 'USER', wardId: 'OPD', typ: 'access' };
    await expect(strategy.validate(legacy)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
