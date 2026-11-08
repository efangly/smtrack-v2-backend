import { createHash, Hash } from 'node:crypto';
import { Transform, TransformCallback } from 'node:stream';

/**
 * Transform ที่นับจำนวน record และคำนวณ sha256 ระหว่างที่ข้อมูลไหลผ่าน
 *
 * นับ newline เฉพาะที่อยู่นอกเครื่องหมายคำพูด — field ข้อความอิสระ (notifications.detail) หรือ JSON
 * อาจมี \n อยู่ข้างใน ซึ่ง COPY ... CSV จะครอบด้วย "..." (และใช้ "" แทน " ข้างใน จึงสลับสถานะสองครั้ง
 * ได้ผลลัพธ์ถูก) ถ้านับทุก \n จะนับเกินแล้ว export ล้มด้วย row count mismatch
 *
 * ใช้ทั้งตอน export (นับ/แฮชก่อน gzip) และตอน verify (อ่านไฟล์กลับมาแล้วคำนวณซ้ำด้วยวิธีเดียวกัน)
 * `lines` รวมบรรทัด header — ผู้ใช้ต้องหัก 1 เอง
 */
export class CsvStats extends Transform {
  lines = 0;
  private inQuotes = false;
  readonly hash: Hash = createHash('sha256');

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    for (const byte of chunk) {
      if (byte === 0x22) this.inQuotes = !this.inQuotes;
      else if (byte === 0x0a && !this.inQuotes) this.lines++;
    }
    this.hash.update(chunk);
    cb(null, chunk);
  }

  get rowCount(): number {
    return Math.max(0, this.lines - 1);
  }
}
