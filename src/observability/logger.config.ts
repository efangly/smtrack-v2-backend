import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { trace } from '@opentelemetry/api';
import pino from 'pino';
import type { Params } from 'nestjs-pino';

/** path ที่ไม่ควร auto-log: health check ถูกยิงถี่, SSE เป็น connection ค้างยาว */
const IGNORED_PATHS = ['/health', '/telemetry/stream', '/notifications/stream'];

/**
 * ผูก log เข้ากับ trace — ทุกบรรทัดพก trace_id/span_id ของ span ที่ active อยู่
 * นี่คือจุดที่ทำให้ Grafana กระโดดจาก log ใน Loki ไป trace ใน Tempo ได้
 */
function traceContextMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  return { trace_id: traceId, span_id: spanId };
}

export function buildPinoOptions(): Params {
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    pinoHttp: {
      level: process.env.LOG_LEVEL ?? 'info',
      // production พ่น JSON ออก stdout ตรง ๆ ให้ Alloy เก็บไป Loki
      // dev ค่อยจัดสวยให้อ่านง่าย
      transport: isProduction
        ? undefined
        : { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } },
      messageKey: 'message',
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin: traceContextMixin,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          '*.password',
          '*.fcmToken',
          '*.privateKey',
          '*.secretKey',
        ],
        censor: '[REDACTED]',
      },
      genReqId: (req: IncomingMessage) =>
        (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
      customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      autoLogging: {
        ignore: (req: IncomingMessage) => {
          const path = (req.url ?? '').split('?')[0];
          return IGNORED_PATHS.includes(path);
        },
      },
    },
  };
}
