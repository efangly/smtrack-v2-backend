import { metrics } from '@opentelemetry/api';
import { MetricsService } from './metrics.service';

const add = jest.fn();
const record = jest.fn();

const meter = {
  createCounter: jest.fn(() => ({ add })),
  createUpDownCounter: jest.fn(() => ({ add })),
  createHistogram: jest.fn(() => ({ record })),
};

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);
    service = new MetricsService();
  });

  it('นับ MQTT message พร้อม topic และ status', () => {
    service.recordMqttMessage('devices/A1/log', 'success');
    expect(add).toHaveBeenCalledWith(1, { topic: 'devices/A1/log', status: 'success' });
  });

  it('บันทึกเวลา ingest เป็น histogram แยกตาม serial', () => {
    service.recordIngestDuration(42, 'A1');
    expect(record).toHaveBeenCalledWith(42, { serial: 'A1' });
  });

  it.each(['sse', 'fcm'] as const)('นับผลการส่ง notification ช่องทาง %s', (channel) => {
    service.recordNotificationDelivery(channel, 'error');
    expect(add).toHaveBeenCalledWith(1, { channel, status: 'error' });
  });

  it('SSE connection counter ขึ้น +1 ตอนเปิด และ -1 ตอนปิด', () => {
    service.sseConnectionOpened('telemetry');
    expect(add).toHaveBeenLastCalledWith(1, { channel: 'telemetry' });

    service.sseConnectionClosed('telemetry');
    expect(add).toHaveBeenLastCalledWith(-1, { channel: 'telemetry' });
  });
});
