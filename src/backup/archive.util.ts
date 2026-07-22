export type MonthString = `${number}-${number}` & string; // "YYYY-MM"

const MONTH_FORMAT = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthString(value: string): value is MonthString {
  return MONTH_FORMAT.test(value);
}

/** โครงสร้าง key บน MinIO/S3: log-days/2026/01/log-days-2026-01.csv.gz */
export function archiveObjectKey(month: MonthString): string {
  const [y, m] = month.split('-');
  return `log-days/${y}/${m}/log-days-${month}.csv.gz`;
}

export function metaObjectKey(month: MonthString): string {
  return archiveObjectKey(month).replace(/\.csv\.gz$/, '.meta.json');
}

/** ขอบเขตเวลาแบบ UTC ของเดือนนั้น: [from, to) */
export function monthRange(month: MonthString): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number);
  return {
    from: new Date(Date.UTC(y, m - 1, 1)),
    to: new Date(Date.UTC(y, m, 1)),
  };
}
