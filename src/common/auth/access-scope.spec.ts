import { AccessScope, canAccess, deviceWhere, scopeFromClaims, scopeKey } from './access-scope';

const tenantAll: AccessScope = { kind: 'TENANT', tenantId: 'T1', departments: 'ALL' };
const tenantSome: AccessScope = { kind: 'TENANT', tenantId: 'T1', departments: ['OPD', 'ICU'] };

describe('scopeFromClaims', () => {
  it.each(['SUPER', 'SERVICE'])('%s เห็นทุก tenant แม้ไม่มี tenantId', (role) => {
    expect(scopeFromClaims({ role })).toEqual({ kind: 'GLOBAL' });
  });

  it.each(['ADMIN', 'LEGACY_ADMIN'])('%s เห็นทุก department ใน tenant ตัวเอง', (role) => {
    expect(scopeFromClaims({ role, tenantId: 'T1', departmentIds: ['OPD'] })).toEqual(tenantAll);
  });

  it.each(['USER', 'LEGACY_USER', 'GUEST'])(
    '%s เห็นตาม departmentIds เมื่อไม่มี departmentScope',
    (role) => {
      expect(scopeFromClaims({ role, tenantId: 'T1', departmentIds: ['OPD', 'ICU'] })).toEqual(
        tenantSome,
      );
    },
  );

  it("user ที่ได้ departmentScope='ALL' เห็นทั้ง tenant", () => {
    expect(
      scopeFromClaims({ role: 'USER', tenantId: 'T1', departmentIds: [], departmentScope: 'ALL' }),
    ).toEqual(tenantAll);
  });

  it("departmentScope='SELECTED' หรือค่าแปลก ๆ ยังใช้ departmentIds", () => {
    expect(
      scopeFromClaims({
        role: 'USER',
        tenantId: 'T1',
        departmentIds: ['OPD'],
        departmentScope: 'all',
      }),
    ).toEqual({ kind: 'TENANT', tenantId: 'T1', departments: ['OPD'] });
  });

  it('departmentIds ที่ไม่ใช่ array หรือมีค่าที่ไม่ใช่ string ไม่หลุดเข้า scope', () => {
    expect(scopeFromClaims({ role: 'USER', tenantId: 'T1', departmentIds: 'OPD' })).toEqual({
      kind: 'TENANT',
      tenantId: 'T1',
      departments: [],
    });
    expect(
      scopeFromClaims({ role: 'USER', tenantId: 'T1', departmentIds: ['OPD', 42, null] }),
    ).toEqual({ kind: 'TENANT', tenantId: 'T1', departments: ['OPD'] });
  });

  it.each(['ADMIN', 'USER'])('%s ที่ไม่มี tenantId ได้ null (ผู้เรียกต้องปฏิเสธ)', (role) => {
    expect(scopeFromClaims({ role, departmentIds: ['OPD'] })).toBeNull();
    expect(scopeFromClaims({ role, tenantId: '' })).toBeNull();
  });
});

describe('canAccess', () => {
  it('GLOBAL เห็นทุกอย่าง รวมถึงจุดที่ยังไม่มี tenant', () => {
    expect(canAccess({ kind: 'GLOBAL' }, { tenantId: null, departmentId: null })).toBe(true);
  });

  it('ทั้ง tenant: เห็นทุก department ใน tenant ตัวเอง แต่ไม่เห็น tenant อื่น', () => {
    expect(canAccess(tenantAll, { tenantId: 'T1', departmentId: 'ER' })).toBe(true);
    expect(canAccess(tenantAll, { tenantId: 'T2', departmentId: 'OPD' })).toBe(false);
  });

  it('บาง department: ต้องตรงทั้ง tenant และ department', () => {
    expect(canAccess(tenantSome, { tenantId: 'T1', departmentId: 'ICU' })).toBe(true);
    expect(canAccess(tenantSome, { tenantId: 'T1', departmentId: 'ER' })).toBe(false);
    // department ชื่อเดียวกันใน tenant อื่นต้องไม่ผ่าน
    expect(canAccess(tenantSome, { tenantId: 'T2', departmentId: 'OPD' })).toBe(false);
  });

  it('จุดที่ยังไม่มี tenant เห็นได้เฉพาะ GLOBAL', () => {
    expect(canAccess(tenantAll, { tenantId: null, departmentId: 'OPD' })).toBe(false);
    expect(canAccess(tenantSome, { tenantId: null, departmentId: 'OPD' })).toBe(false);
  });
});

describe('deviceWhere / scopeKey', () => {
  it('สร้าง where ตามชนิด scope', () => {
    expect(deviceWhere({ kind: 'GLOBAL' })).toEqual({});
    expect(deviceWhere(tenantAll)).toEqual({ tenantId: 'T1' });
    expect(deviceWhere(tenantSome)).toEqual({
      tenantId: 'T1',
      departmentId: { in: ['OPD', 'ICU'] },
    });
  });

  it('scope เดียวกันได้ key เดียวกันไม่ว่าลำดับ department แต่ tenant ต่างกันได้ key ต่างกัน', () => {
    const reordered: AccessScope = { kind: 'TENANT', tenantId: 'T1', departments: ['ICU', 'OPD'] };
    const otherTenant: AccessScope = {
      kind: 'TENANT',
      tenantId: 'T2',
      departments: ['OPD', 'ICU'],
    };
    expect(scopeKey(tenantSome)).toBe(scopeKey(reordered));
    expect(scopeKey(tenantSome)).not.toBe(scopeKey(otherTenant));
    expect(scopeKey(tenantSome)).not.toBe(scopeKey(tenantAll));
    expect(scopeKey({ kind: 'GLOBAL' })).toBe('global');
  });
});
