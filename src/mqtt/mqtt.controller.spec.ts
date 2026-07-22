import { MqttContext } from '@nestjs/microservices';
import { MqttController } from './mqtt.controller';
import { TelemetryService } from '../telemetry/telemetry.service';
import { CreateTelemetryDto } from '../telemetry/dto/create-telemetry.dto';
import { TraceService } from '../observability/trace.service';
import { MetricsService } from '../observability/metrics.service';
import { createMetricsMock } from '../observability/testing';

describe('MqttController', () => {
  let controller: MqttController;
  let telemetry: { ingest: jest.Mock };
  let metrics: jest.Mocked<MetricsService>;

  const ctx = (topic: string) => ({ getTopic: () => topic }) as unknown as MqttContext;

  beforeEach(() => {
    telemetry = { ingest: jest.fn().mockResolvedValue(undefined) };
    metrics = createMetricsMock();
    controller = new MqttController(
      telemetry as unknown as TelemetryService,
      new TraceService(),
      metrics,
    );
  });

  it('handler เรียก telemetry.ingest ด้วย payload (แยก handler จาก business logic)', async () => {
    const payload: CreateTelemetryDto = { serial: 'SN-1', temp: 4 };
    await controller.handleDeviceLog(payload, ctx('devices/SN-1/log'));
    expect(telemetry.ingest).toHaveBeenCalledWith(payload);
  });

  it('เติม serial จาก topic เมื่อ payload ไม่มี serial', async () => {
    const payload = { temp: 4 } as CreateTelemetryDto;
    await controller.handleDeviceLog(payload, ctx('devices/SN-FROM-TOPIC/log'));
    expect(payload.serial).toBe('SN-FROM-TOPIC');
    expect(telemetry.ingest).toHaveBeenCalledWith(payload);
  });

  it('serial ใน payload ชนะค่าจาก topic', async () => {
    const payload: CreateTelemetryDto = { serial: 'SN-PAYLOAD', temp: 4 };
    await controller.handleDeviceLog(payload, ctx('devices/SN-TOPIC/log'));
    expect(payload.serial).toBe('SN-PAYLOAD');
  });

  it('เติม serial จาก topic เมื่อ payload ส่ง serial มาเป็นช่องว่าง', async () => {
    const payload = { serial: '  ', temp: 4 } as CreateTelemetryDto;
    await controller.handleDeviceLog(payload, ctx('devices/SN-TOPIC/log'));
    expect(payload.serial).toBe('SN-TOPIC');
  });

  it('นับ metric เป็น success เมื่อ ingest ผ่าน', async () => {
    await controller.handleDeviceLog({ serial: 'SN-1', temp: 4 }, ctx('devices/SN-1/log'));
    expect(metrics.recordMqttMessage).toHaveBeenCalledWith('devices/SN-1/log', 'success');
  });

  it('นับ metric เป็น error แล้วโยน error ต่อให้ exception filter จัดการ', async () => {
    telemetry.ingest.mockRejectedValue(new Error('db down'));

    await expect(
      controller.handleDeviceLog({ serial: 'SN-1', temp: 4 }, ctx('devices/SN-1/log')),
    ).rejects.toThrow('db down');
    expect(metrics.recordMqttMessage).toHaveBeenCalledWith('devices/SN-1/log', 'error');
  });
});
