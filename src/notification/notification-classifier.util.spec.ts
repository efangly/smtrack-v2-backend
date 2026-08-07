import { classifyNotification } from './notification-classifier.util';

describe('classifyNotification', () => {
  it('SD/OFF → SDCARD/warning', () => {
    expect(classifyNotification('SD/OFF')).toEqual({ category: 'SDCARD', severity: 'warning' });
  });

  it('AC/OFF → PLUG/warning', () => {
    expect(classifyNotification('AC/OFF')).toEqual({ category: 'PLUG', severity: 'warning' });
  });

  it('INTERNET/OFF → INTERNET/warning', () => {
    expect(classifyNotification('INTERNET/OFF')).toEqual({
      category: 'INTERNET',
      severity: 'warning',
    });
  });

  it('{code}/TEMP/OVER → TEMP/critical', () => {
    expect(classifyNotification('PROBE/TEMP/OVER')).toEqual({
      category: 'TEMP',
      severity: 'critical',
    });
  });

  it('{code}/TEMP/LOWER → TEMP/critical', () => {
    expect(classifyNotification('PROBE/TEMP/LOWER')).toEqual({
      category: 'TEMP',
      severity: 'critical',
    });
  });

  it('{code}/{doorNo}/ON → DOOR/warning', () => {
    expect(classifyNotification('SN-1/1/ON')).toEqual({ category: 'DOOR', severity: 'warning' });
  });

  it('มีคำว่า REPORT → REPORT/info', () => {
    expect(classifyNotification('DAILY/REPORT')).toEqual({ category: 'REPORT', severity: 'info' });
  });

  it('ไม่เข้าเงื่อนไขไหนเลย → OTHER/info', () => {
    expect(classifyNotification('hello world')).toEqual({ category: 'OTHER', severity: 'info' });
  });
});
