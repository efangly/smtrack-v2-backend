import http from 'http';

export interface SseEvent {
  event?: string;
  data: unknown;
}

/**
 * SSE client เล็ก ๆ สำหรับ e2e — supertest ใช้กับ stream ที่ไม่มีวันจบไม่ได้
 * เพราะมันรอจน response ปิด ต้องอ่าน chunk ดิบเองแล้วแยก event ตาม spec (คั่นด้วย \n\n)
 */
export class SseClient {
  private req?: http.ClientRequest;
  private res?: http.IncomingMessage;
  private buffer = '';
  private readonly received: SseEvent[] = [];
  private waiter?: { match: (e: SseEvent) => boolean; resolve: (e: SseEvent) => void };

  /** เปิด connection และ resolve เมื่อได้ response header แล้ว (พร้อมรับ event) */
  async connect(port: number, path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.req = http.get(
        { host: '127.0.0.1', port, path, headers: { Accept: 'text/event-stream' } },
        (res) => {
          this.res = res;
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => this.onChunk(chunk));
          resolve();
        },
      );
      this.req.on('error', reject);
    });
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    // event หนึ่งจบด้วยบรรทัดว่าง — อาจมาไม่ครบใน chunk เดียว จึงต้อง buffer ไว้
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const parsed = this.parse(raw);
      if (!parsed) continue;

      this.received.push(parsed);
      if (this.waiter?.match(parsed)) {
        this.waiter.resolve(parsed);
        this.waiter = undefined;
      }
    }
  }

  private parse(raw: string): SseEvent | null {
    let event: string | undefined;
    const dataLines: string[] = [];

    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return null;

    const data = dataLines.join('\n');
    try {
      return { event, data: JSON.parse(data) };
    } catch {
      return { event, data };
    }
  }

  /** รอ event ถัดไปที่ตรงเงื่อนไข (ตรวจของที่มาถึงแล้วก่อน เผื่อมาก่อนที่จะเรียก) */
  waitFor(match: (e: SseEvent) => boolean, timeoutMs = 10_000): Promise<SseEvent> {
    const already = this.received.find(match);
    if (already) return Promise.resolve(already);

    return new Promise<SseEvent>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`หมดเวลารอ SSE event (ได้รับมาแล้ว ${this.received.length} event)`)),
        timeoutMs,
      );
      this.waiter = {
        match,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      };
    });
  }

  get events(): SseEvent[] {
    return [...this.received];
  }

  /** ต้องเรียกเสมอ ไม่งั้น connection ค้างแล้ว Jest จะไม่ยอมจบ */
  close(): void {
    this.res?.destroy();
    this.req?.destroy();
  }
}
