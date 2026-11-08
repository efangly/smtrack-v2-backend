import { parseArgs } from './archive-job';

describe('archive-job parseArgs', () => {
  it('คำสั่งเปล่า', () => {
    expect(parseArgs(['export-and-drop'])).toEqual({
      command: 'export-and-drop',
      dryRun: false,
      tables: undefined,
      from: undefined,
      to: undefined,
    });
  });

  it('--dry-run และ --table', () => {
    expect(
      parseArgs(['export-and-drop', '--dry-run', '--table=log_days,user_audit']),
    ).toMatchObject({
      command: 'export-and-drop',
      dryRun: true,
      tables: ['log_days', 'user_audit'],
    });
  });

  it('รับคำสั่ง cleanup-restored', () => {
    expect(parseArgs(['cleanup-restored', '--dry-run'])).toMatchObject({
      command: 'cleanup-restored',
      dryRun: true,
    });
  });

  it('backfill รับช่วงเดือน', () => {
    expect(
      parseArgs(['backfill', '--from=2026-01', '--to=2026-06', '--table=log_days']),
    ).toMatchObject({
      command: 'backfill',
      from: '2026-01',
      to: '2026-06',
      tables: ['log_days'],
    });
  });

  it('verify รับช่วงเดือนและตาราง แต่ไม่รับ --dry-run (อ่านอย่างเดียวอยู่แล้ว)', () => {
    expect(parseArgs(['verify', '--table=notifications'])).toMatchObject({
      command: 'verify',
      tables: ['notifications'],
    });
    expect(parseArgs(['verify', '--dry-run'])).toEqual({
      error: '--dry-run is not valid for verify (it never writes)',
    });
  });

  it('--from/--to ใช้ได้เฉพาะ backfill และ verify', () => {
    expect(parseArgs(['export-and-drop', '--from=2026-01'])).toEqual({
      error: '--from is only valid for backfill and verify',
    });
  });

  it('ปฏิเสธรูปแบบเดือนผิดและช่วงที่ย้อนกลับ', () => {
    expect(parseArgs(['backfill', '--from=2026-13'])).toEqual({
      error: '--from must be YYYY-MM, got "2026-13"',
    });
    expect(parseArgs(['backfill', '--from=2026-06', '--to=2026-01'])).toEqual({
      error: '--from (2026-06) is after --to (2026-01)',
    });
  });

  it('ปฏิเสธชื่อตารางที่ไม่รู้จัก และ --table กับ cleanup-restored', () => {
    expect(parseArgs(['export-and-drop', '--table=users'])).toEqual({
      error: 'unknown table: users',
    });
    expect(parseArgs(['cleanup-restored', '--table=log_days'])).toEqual({
      error: '--table is not valid for cleanup-restored',
    });
  });

  it('ปฏิเสธ option และคำสั่งที่ไม่รู้จัก', () => {
    expect(parseArgs(['export-and-drop', '--force'])).toEqual({ error: 'unknown option: --force' });
    expect(parseArgs(['bogus'])).toEqual({ error: 'unknown command: bogus' });
    expect(parseArgs([])).toEqual({ error: 'unknown command: ' });
  });
});
