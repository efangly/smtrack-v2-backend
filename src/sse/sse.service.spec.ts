import { MessageEvent } from '@nestjs/common';
import { take, toArray } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';
import { SseService } from './sse.service';
import { MetricsService } from '../observability/metrics.service';
import { createMetricsMock } from '../observability/testing';

describe('SseService', () => {
  let service: SseService;
  let metrics: jest.Mocked<MetricsService>;

  beforeEach(() => {
    metrics = createMetricsMock();
    service = new SseService(metrics);
  });

  it('subscribe stream แล้วได้รับเฉพาะ event ของ channel ที่ระบุ', async () => {
    const collected = firstValueFrom(service.streamFor('notification').pipe(take(1), toArray()));

    // ยิง telemetry ก่อน (ควรถูก filter ทิ้ง) แล้วตามด้วย notification
    service.broadcast('telemetry', { serial: 'X' });
    service.broadcast('notification', { id: 'n1' });

    const events = (await collected) as MessageEvent[];
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('notification');
    expect(events[0].data).toEqual({ id: 'n1' });
  });

  it('handleTelemetryCreated broadcast เข้า channel telemetry', async () => {
    const collected = firstValueFrom(service.streamFor('telemetry').pipe(take(1), toArray()));
    service.handleTelemetryCreated({ serial: 'SN-1' });
    const events = (await collected) as MessageEvent[];
    expect(events[0].data).toEqual({ serial: 'SN-1' });
    expect(events[0].type).toBe('telemetry');
  });

  it('handleNotificationCreated broadcast เข้า channel notification', async () => {
    const collected = firstValueFrom(service.streamFor('notification').pipe(take(1), toArray()));
    service.handleNotificationCreated({ id: 'n2' });
    const events = (await collected) as MessageEvent[];
    expect(events[0].data).toEqual({ id: 'n2' });
  });

  it('นับ connection ขึ้นตอน subscribe และลงตอน unsubscribe', async () => {
    const sub = service.streamFor('telemetry').subscribe();
    expect(metrics.sseConnectionOpened).toHaveBeenCalledWith('telemetry');
    expect(metrics.sseConnectionClosed).not.toHaveBeenCalled();

    sub.unsubscribe();
    expect(metrics.sseConnectionClosed).toHaveBeenCalledWith('telemetry');
  });
});
