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

  // อุปกรณ์จริงส่ง sendTime พร้อม `Z` ต่อท้ายเสมอ แต่ตัวเลขนาฬิกาเป็นเวลาไทย ไม่ใช่ UTC
  // (ยืนยันจาก log สด: อุปกรณ์ส่ง "...T21:52:07.000Z" ขณะที่เวลา UTC จริงคือ 14:52:07Z)
  // ต้องตัด suffix ที่ให้มาทิ้งแล้วตีความใหม่เป็นเวลาไทยเสมอ ห้ามปล่อยผ่านเด็ดขาด
  it.each([
    ['2026-08-01T10:00:00Z', '2026-08-01T10:00:00+07:00'],
    ['2026-08-01T10:00:00+07:00', '2026-08-01T10:00:00+07:00'],
    ['2026-08-01T10:00:00-0500', '2026-08-01T10:00:00+07:00'],
  ])(
    'ไม่เชื่อ timezone suffix ที่อุปกรณ์ส่งมา ตีความตัวเลขนาฬิกาเป็นเวลาไทยใหม่เสมอ: %s',
    (input, expected) => {
      expect(normalizeToUtcIso(input)).toBe(expected);
    },
  );

  it.each([['not-a-date'], [1754042400000], [null], [undefined]])(
    'คืนค่าเดิมให้สิ่งที่ไม่ใช่เวลา เพื่อให้ @IsDateString เป็นคนปัดตก: %s',
    (input) => {
      expect(normalizeToUtcIso(input)).toBe(input);
    },
  );
});
