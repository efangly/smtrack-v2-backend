import { RmqContext } from '@nestjs/microservices';
import { LogConsumerController } from './log-consumer.controller';
import { TelemetryService } from '../telemetry/telemetry.service';
import { CreateTelemetryDto } from '../telemetry/dto/create-telemetry.dto';
import { TraceService } from '../observability/trace.service';
import { createMetricsMock } from '../observability/testing';

describe('LogConsumerController', () => {
  let controller: LogConsumerController;
  let telemetry: { ingest: jest.Mock };
  let ack: jest.Mock;
  let nack: jest.Mock;

  const ctx = () =>
    ({
      getChannelRef: () => ({ ack, nack }),
      getMessage: () => ({}),
    }) as unknown as RmqContext;

  beforeEach(() => {
    telemetry = { ingest: jest.fn().mockResolvedValue(undefined) };
    ack = jest.fn();
    nack = jest.fn();
    controller = new LogConsumerController(
      telemetry as unknown as TelemetryService,
      new TraceService(),
      createMetricsMock(),
    );
  });

  it('เรียก telemetry.ingest ด้วย payload แล้ว ack เมื่อสำเร็จ', async () => {
    const payload: CreateTelemetryDto = { serial: 'SN-1', temp: 4 };
    await controller.handleDeviceLog(payload, ctx());
    expect(telemetry.ingest).toHaveBeenCalledWith(payload);
    expect(ack).toHaveBeenCalled();
    expect(nack).not.toHaveBeenCalled();
  });

  it('nack แบบไม่ requeue เมื่อ ingest ล้มเหลว', async () => {
    telemetry.ingest.mockRejectedValue(new Error('db down'));
    const payload: CreateTelemetryDto = { serial: 'SN-1', temp: 4 };
    await controller.handleDeviceLog(payload, ctx());
    expect(nack).toHaveBeenCalledWith({}, false, false);
    expect(ack).not.toHaveBeenCalled();
  });
});
