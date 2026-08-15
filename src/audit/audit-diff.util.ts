export type FieldDiff = Record<string, { from: unknown; to: unknown }>;

/** field ที่เปลี่ยนอัตโนมัติทุก write ไม่ใช่การแก้ไขจริงของ user จึงไม่นับเป็นส่วนหนึ่งของ diff */
const IGNORED_FIELDS = new Set(['id', 'createAt', 'updateAt']);

/**
 * เทียบ snapshot สองก้อน (เก่า/ใหม่) แล้วคืนเฉพาะ field ที่ค่าต่างกันจริง
 * คืน `{}` (ไม่ใช่ null) เมื่อไม่มี field ไหนเปลี่ยนเลย — ผู้เรียกตัดสินใจเองว่าจะตีความว่าเป็น no-op หรือไม่
 */
export function computeSnapshotDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldDiff {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff: FieldDiff = {};

  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue;
    const from = before[key];
    const to = after[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      diff[key] = { from, to };
    }
  }

  return diff;
}
