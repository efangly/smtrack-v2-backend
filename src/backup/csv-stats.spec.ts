import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { CsvStats } from './csv-stats';

async function run(csv: string, chunk = 7) {
  const stats = new CsvStats();
  const buf = Buffer.from(csv);
  // แบ่งเป็นชิ้นเล็กเพื่อพิสูจน์ว่าสถานะเครื่องหมายคำพูดข้ามขอบ chunk ได้
  const parts = Array.from({ length: Math.ceil(buf.length / chunk) }, (_, i) =>
    buf.subarray(i * chunk, (i + 1) * chunk),
  );
  await pipeline(Readable.from(parts), stats, async (src) => {
    for await (const _ of src) void _;
  });
  return stats;
}

describe('CsvStats', () => {
  it('นับ record ไม่รวม header และคำนวณ sha256 ของไบต์ทั้งหมด', async () => {
    const csv = 'id,v\na,1\nb,2\n';
    const s = await run(csv);
    expect(s.rowCount).toBe(2);
    expect(s.hash.digest('hex')).toBe(createHash('sha256').update(csv).digest('hex'));
  });

  it('newline ภายในเครื่องหมายคำพูด (รวม "" escape) ไม่ถูกนับเป็น record', async () => {
    const s = await run('id,detail\nn1,"l1\nl2 ""q""\nl3"\nn2,plain\n');
    expect(s.rowCount).toBe(2);
  });

  it('ไฟล์มีแค่ header: 0 แถว', async () => {
    expect((await run('id,v\n')).rowCount).toBe(0);
  });

  it('ไฟล์ว่าง: 0 แถว (ไม่ติดลบ)', async () => {
    expect((await run('')).rowCount).toBe(0);
  });
});
