import { Injectable } from '@nestjs/common';
import { Attributes, Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

const TRACER_NAME = 'smtrack-backend';

/**
 * ห่อ tracer.startActiveSpan ให้เรียกสั้น ๆ — ใช้กับ flow ที่ auto-instrumentation
 * มองไม่เห็น (MQTT, EventEmitter2 fan-out, SSE, FCM)
 */
@Injectable()
export class TraceService {
  private readonly tracer = trace.getTracer(TRACER_NAME);

  /** รัน fn ภายใน span ใหม่ — set status/recordException ให้อัตโนมัติเมื่อ throw */
  async withSpan<T>(
    name: string,
    attributes: Attributes,
    fn: (span: Span) => Promise<T>,
    kind: SpanKind = SpanKind.INTERNAL,
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, { attributes, kind }, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        this.recordError(span, err);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /** บันทึก exception ลง span ที่ active อยู่ (ถ้ามี) — ใช้ในจุดที่กลืน error ไว้เอง */
  recordOnActiveSpan(err: unknown): void {
    const span = trace.getActiveSpan();
    if (span) this.recordError(span, err);
  }

  private recordError(span: Span, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }
}
