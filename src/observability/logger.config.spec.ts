import type { IncomingMessage, ServerResponse } from 'node:http';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { buildPinoOptions } from './logger.config';

type PinoHttpOptions = ReturnType<typeof buildPinoOptions>['pinoHttp'] & {
  mixin: () => Record<string, string>;
  redact: { paths: string[]; censor: string };
  genReqId: (req: IncomingMessage) => string;
  customLogLevel: (req: IncomingMessage, res: ServerResponse, err?: Error) => string;
  autoLogging: { ignore: (req: IncomingMessage) => boolean };
};

const options = (): PinoHttpOptions => buildPinoOptions().pinoHttp as PinoHttpOptions;
const asReq = (partial: Partial<IncomingMessage>): IncomingMessage =>
  ({ headers: {}, ...partial }) as IncomingMessage;

describe('buildPinoOptions', () => {
  // ไม่มี context manager = getActiveSpan() คืน undefined เสมอ ต้อง register ก่อน
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });
  afterAll(() => {
    context.disable();
  });

  describe('mixin — trace correlation', () => {
    it('ไม่ใส่อะไรเมื่อไม่มี active span', () => {
      expect(options().mixin()).toEqual({});
    });

    it('ใส่ trace_id/span_id ของ span ที่ active อยู่', () => {
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
      });
      const span = provider.getTracer('test').startSpan('unit');

      const result = context.with(trace.setSpan(context.active(), span), () => options().mixin());

      const spanContext = span.spanContext();
      expect(result).toEqual({
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
      });
      span.end();
    });
  });

  describe('redact', () => {
    it('ปกปิด credential และ token ที่อ่อนไหว', () => {
      const { paths, censor } = options().redact;
      expect(paths).toEqual(
        expect.arrayContaining([
          'req.headers.authorization',
          'req.headers.cookie',
          '*.password',
          '*.fcmToken',
          '*.privateKey',
          '*.secretKey',
        ]),
      );
      expect(censor).toBe('[REDACTED]');
    });
  });

  describe('autoLogging.ignore', () => {
    it.each(['/health', '/telemetry/stream', '/notifications/stream'])('ข้าม %s', (url) => {
      expect(options().autoLogging.ignore(asReq({ url }))).toBe(true);
    });

    it('ข้าม SSE path ที่มี query string ต่อท้าย', () => {
      expect(options().autoLogging.ignore(asReq({ url: '/telemetry/stream?serial=A1' }))).toBe(
        true,
      );
    });

    it('ไม่ข้าม endpoint ปกติ', () => {
      expect(options().autoLogging.ignore(asReq({ url: '/telemetry?limit=10' }))).toBe(false);
    });
  });

  describe('genReqId', () => {
    it('ใช้ x-request-id จาก header ถ้ามี (คง correlation ข้าม service)', () => {
      expect(options().genReqId(asReq({ headers: { 'x-request-id': 'req-abc' } }))).toBe('req-abc');
    });

    it('generate ให้ใหม่เมื่อไม่มี header', () => {
      const id = options().genReqId(asReq({}));
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('customLogLevel', () => {
    const res = (statusCode: number): ServerResponse => ({ statusCode }) as ServerResponse;

    it.each([
      [500, 'error'],
      [503, 'error'],
      [404, 'warn'],
      [400, 'warn'],
      [200, 'info'],
      [304, 'info'],
    ])('status %i → %s', (status, level) => {
      expect(options().customLogLevel(asReq({}), res(status))).toBe(level);
    });

    it('error → error แม้ status จะเป็น 2xx', () => {
      expect(options().customLogLevel(asReq({}), res(200), new Error('boom'))).toBe('error');
    });
  });
});
