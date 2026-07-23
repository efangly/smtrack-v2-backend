import { Provider } from '@nestjs/common';
import { TraceService } from './trace.service';
import { MetricsService } from './metrics.service';

/**
 * Helper สำหรับ unit test — TraceService ตัวจริงใช้ได้เลยเพราะเมื่อไม่มี SDK
 * มันจะได้ no-op tracer อยู่แล้ว ส่วน metric mock ไว้ให้ assert ได้
 */
export const createMetricsMock = (): jest.Mocked<MetricsService> =>
  ({
    recordMqttMessage: jest.fn(),
    recordRmqMessage: jest.fn(),
    recordIngestDuration: jest.fn(),
    recordNotificationDelivery: jest.fn(),
    sseConnectionOpened: jest.fn(),
    sseConnectionClosed: jest.fn(),
  }) as unknown as jest.Mocked<MetricsService>;

/** providers ของ observability สำหรับใส่ใน Test.createTestingModule */
export const observabilityTestProviders = (
  metrics: MetricsService = createMetricsMock(),
): Provider[] => [TraceService, { provide: MetricsService, useValue: metrics }];
