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

  it('ตัด field ที่ v2 ไม่มี (id/createAt/updateAt) ออกจาก payload ของ legacy', async () => {
    await controller.handleDeviceLog(
      { id: 'legacy-uuid', serial: 'SN-1', temp: 4, createAt: '2026-08-01T00:00:00.000Z' },
      ctx(),
    );
    expect(telemetry.ingest).toHaveBeenCalledWith({ serial: 'SN-1', temp: 4 });
    expect(ack).toHaveBeenCalled();
  });

  it('ปัด battery ที่เป็น float ให้เป็นจำนวนเต็ม (เป็น % ไม่ใช่แรงดัน)', async () => {
    await controller.handleDeviceLog({ serial: 'SN-1', battery: 86.6 }, ctx());
    expect(telemetry.ingest).toHaveBeenCalledWith(expect.objectContaining({ battery: 87 }));
    expect(ack).toHaveBeenCalled();
  });

  it('ตีความ sendTime ที่ไม่ระบุ timezone เป็นเวลาท้องถิ่น Asia/Bangkok ไม่ใช่เวลาท้องถิ่นของ server', async () => {
    await controller.handleDeviceLog({ serial: 'SN-1', sendTime: '2026-08-01 10:00:00' }, ctx());
    expect(telemetry.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ sendTime: '2026-08-01T10:00:00+07:00' }),
    );
    expect(new Date('2026-08-01T10:00:00+07:00').toISOString()).toBe('2026-08-01T03:00:00.000Z');
    expect(ack).toHaveBeenCalled();
  });

  it.each(['not-a-date', 1754042400000])(
    'nack sendTime ที่ไม่ใช่ ISO 8601 แทนที่จะค้าง unacked แล้ว requeue วน: %s',
    async (v) => {
      await controller.handleDeviceLog({ serial: 'SN-1', sendTime: v }, ctx());
      expect(telemetry.ingest).not.toHaveBeenCalled();
      expect(nack).toHaveBeenCalledWith({}, false, false);
      expect(ack).not.toHaveBeenCalled();
    },
  );
});
