import {
  archiveObjectKey,
  hotWindowStart,
  isMonthString,
  metaObjectKey,
  monthRange,
} from './archive.util';

describe('archive.util', () => {
  describe('isMonthString', () => {
    it('ยอมรับ YYYY-MM ที่ถูกต้อง', () => {
      expect(isMonthString('2026-01')).toBe(true);
      expect(isMonthString('2026-12')).toBe(true);
    });

    it('ปฏิเสธรูปแบบที่ไม่ถูกต้อง', () => {
      expect(isMonthString('2026-00')).toBe(false);
      expect(isMonthString('2026-13')).toBe(false);
      expect(isMonthString('2026-1')).toBe(false);
      expect(isMonthString('2026/01')).toBe(false);
      expect(isMonthString('not-a-month')).toBe(false);
    });
  });

  describe('archiveObjectKey / metaObjectKey', () => {
    it('สร้าง key ตามโครงสร้าง log-days/YYYY/MM/log-days-YYYY-MM.csv.gz', () => {
      expect(archiveObjectKey('2026-01')).toBe('log-days/2026/01/log-days-2026-01.csv.gz');
    });

    it('metaObjectKey แทนที่ .csv.gz ด้วย .meta.json', () => {
      expect(metaObjectKey('2026-01')).toBe('log-days/2026/01/log-days-2026-01.meta.json');
    });
  });

  describe('monthRange', () => {
    it('คืนขอบเขต UTC [from, to) ของเดือนนั้น', () => {
      const { from, to } = monthRange('2026-02');
      expect(from.toISOString()).toBe('2026-02-01T00:00:00.000Z');
      expect(to.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    });

    it('จัดการข้ามปีถูกต้อง (ธันวาคม -> มกราคม)', () => {
      const { from, to } = monthRange('2025-12');
      expect(from.toISOString()).toBe('2025-12-01T00:00:00.000Z');
      expect(to.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  describe('hotWindowStart', () => {
    const at = (iso: string) => hotWindowStart(new Date(iso)).toISOString();

    it('กลางเดือน: วันที่ 1 ของเดือนก่อนหน้า', () => {
      expect(at('2026-07-15T00:00:00.000Z')).toBe('2026-06-01T00:00:00.000Z');
    });

    it('วันที่ 1 ของเดือน: ยังเป็นเดือนก่อนหน้า (export เดือนก่อนหน้าแล้วก็ยังไม่ถูกลบ)', () => {
      expect(at('2026-07-01T03:00:00.000Z')).toBe('2026-06-01T00:00:00.000Z');
      expect(at('2026-08-01T00:00:00.000Z')).toBe('2026-07-01T00:00:00.000Z');
    });

    it('ต้นมีนาคม (กุมภาพันธ์ 28 วัน): ถอยไปมกราคมเพื่อให้ย้อน 30 วันได้ครบ', () => {
      expect(at('2026-03-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
      expect(at('2026-03-02T12:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
      expect(at('2026-03-03T12:00:00.000Z')).toBe('2026-02-01T00:00:00.000Z');
    });

    it('ครอบคลุม 30 วันย้อนหลังเสมอ', () => {
      for (let d = 0; d < 400; d++) {
        const now = new Date(Date.UTC(2026, 0, 1) + d * 86_400_000);
        expect(hotWindowStart(now).getTime()).toBeLessThanOrEqual(now.getTime() - 30 * 86_400_000);
      }
    });
  });
});
