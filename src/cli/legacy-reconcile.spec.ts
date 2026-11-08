import { diffDailyCounts, parseDays } from './legacy-reconcile';

describe('legacy-reconcile', () => {
  it('รายงานเฉพาะ serial-day ที่ v2 มีน้อยกว่าระบบเดิม', () => {
    const legacy = [
      { serial: 'SN-1', day: '2026-11-07', count: 288 },
      { serial: 'SN-2', day: '2026-11-07', count: 288 },
      { serial: 'SN-3', day: '2026-11-07', count: 10 },
    ];
    const v2 = [
      { serial: 'SN-1', day: '2026-11-07', count: 288 },
      { serial: 'SN-2', day: '2026-11-07', count: 280 },
      // SN-3 ไม่มีเลย, SN-4 มีเฉพาะใน v2 (ส่งตรงเข้า v2) — ไม่นับเป็น mismatch
      { serial: 'SN-4', day: '2026-11-07', count: 5 },
    ];
    expect(diffDailyCounts(legacy, v2)).toEqual([
      { serial: 'SN-2', day: '2026-11-07', legacy: 288, v2: 280 },
      { serial: 'SN-3', day: '2026-11-07', legacy: 10, v2: 0 },
    ]);
  });

  it('parseDays: default 1 และตรวจช่วง', () => {
    expect(parseDays([])).toBe(1);
    expect(parseDays(['--days=7'])).toBe(7);
    expect(parseDays(['--days=0'])).toEqual({ error: expect.any(String) });
    expect(parseDays(['--days=abc'])).toEqual({ error: expect.any(String) });
  });
});
