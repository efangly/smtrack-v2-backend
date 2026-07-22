/**
 * OpenTelemetry bootstrap — ต้องถูก import เป็นโมดูลแรกสุดของ process
 * ก่อน import library อื่นใด ไม่งั้น auto-instrumentation patch ไม่ทัน
 *
 * ถ้าไม่ได้ตั้ง OTEL_EXPORTER_OTLP_ENDPOINT จะข้าม SDK ทั้งหมด
 * เพื่อให้ dev/test รันได้โดยไม่ต้องมี Collector
 */
import 'reflect-metadata';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  const base = endpoint.replace(/\/$/, '');

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'smtrack-backend',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.0.1',
      'deployment.environment.name': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
      exportIntervalMillis: 30_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs สร้าง span รกเกินประโยชน์
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // trace context ใส่เองผ่าน pino mixin ใน logger.config.ts แล้ว
        '@opentelemetry/instrumentation-pino': { enabled: false },
      }),
    ],
  });

  sdk.start();

  const shutdown = (): void => {
    // flush span/metric ที่ค้างก่อนปิด process
    void sdk.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
