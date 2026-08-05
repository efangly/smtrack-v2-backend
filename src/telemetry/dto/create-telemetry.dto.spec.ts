import { normalizeToUtcIso } from './create-telemetry.dto';

describe('normalizeToUtcIso', () => {
  it.each([
    ['2026-08-01 10:00:00', '2026-08-01T10:00:00+07:00'],
    ['2026-08-01T10:00:00', '2026-08-01T10:00:00+07:00'],
    ['2026-08-01 10:00', '2026-08-01T10:00+07:00'],
    ['2026-08-01 10:00:00.500', '2026-08-01T10:00:00.500+07:00'],
    ['  2026-08-01 10:00:00  ', '2026-08-01T10:00:00+07:00'],
  ])(
    'ผนวก +07:00 ให้เวลาที่ไม่ระบุ timezone (ถือเป็นเวลาท้องถิ่น Asia/Bangkok): %s',
    (input, expected) => {
      expect(normalizeToUtcIso(input)).toBe(expected);
    },
  );

  it('แปลงเป็น UTC instant ที่ถูกต้อง (เพี้ยน 7 ชั่วโมงถ้า mark เป็น Z ตรง ๆ)', () => {
    const normalized = normalizeToUtcIso('2026-08-05 09:06:24') as string;
    expect(new Date(normalized).toISOString()).toBe('2026-08-05T02:06:24.000Z');
  });

  it.each(['2026-08-01T10:00:00Z', '2026-08-01T10:00:00+07:00', '2026-08-01T10:00:00-0500'])(
    'ปล่อยผ่านค่าที่ระบุ timezone มาแล้ว: %s',
    (input) => {
      expect(normalizeToUtcIso(input)).toBe(input);
    },
  );

  it.each([['not-a-date'], [1754042400000], [null], [undefined]])(
    'คืนค่าเดิมให้สิ่งที่ไม่ใช่เวลา เพื่อให้ @IsDateString เป็นคนปัดตก: %s',
    (input) => {
      expect(normalizeToUtcIso(input)).toBe(input);
    },
  );
});
