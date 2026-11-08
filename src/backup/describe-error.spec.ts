import { describeError } from './describe-error';

describe('describeError', () => {
  it('Error ปกติ: ใช้ message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('AggregateError ที่ message ว่าง (ต่อ endpoint ไม่ได้): แสดง code ของ error ข้างใน', () => {
    const agg = new AggregateError(
      [
        Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
        Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
      ],
      '',
    );
    expect(describeError(agg)).toBe('[ECONNREFUSED]');
  });

  it('มี code บน error เอง', () => {
    expect(describeError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(
      'socket hang up ECONNRESET',
    );
  });

  it('ไม่ซ้ำ code ที่อยู่ใน message แล้ว', () => {
    expect(
      describeError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    ).toBe('connect ECONNREFUSED');
  });

  it('error ว่างเปล่าทุกอย่าง: ใช้ชื่อ class', () => {
    expect(describeError(new TypeError(''))).toBe('TypeError');
  });

  it('ไม่ใช่ Error: แปลงเป็นสตริง', () => {
    expect(describeError('x')).toBe('x');
  });
});
