import { RmqContext } from '@nestjs/microservices';
import {
  NotificationConsumerController,
  deriveProbeChannel,
} from './notification-consumer.controller';
import { NotificationService } from '../notification/notification.service';
import { TraceService } from '../observability/trace.service';
import { createMetricsMock } from '../observability/testing';

describe('deriveProbeChannel', () => {
  // format ที่ส่งมาจริง — คัดจากตาราง notifications บนฐานข้อมูลจริง
  it.each([
    ['PROBE1/DOOR2/OFF', '1'],
    ['PROBE1/DOOR1/ON', '1'],
    ['PROBE1/TEMP/OVER/22.20', '1'],
    ['PROBE2/SENSOR/ON', '2'],
  ])('ตัดคำนำหน้า PROBE ออกให้เหลือ channel ที่ตรงกับ probes.channel: %s', (message, expected) => {
    expect(deriveProbeChannel(message)).toBe(expected);
  });

  it.each([
    ['1/DOOR/ON/15', '1'],
    ['2/SENSOR/ON', '2'],
  ])('รับเลขเปล่าได้ด้วย เผื่อ firmware รุ่นที่ไม่ใส่คำนำหน้า: %s', (message, expected) => {
    expect(deriveProbeChannel(message)).toBe(expected);
  });

  it.each(['TEMP/OVER', 'AC/OFF', 'SD/OFF', 'INTERNET/OFF', 'REPORT/DAILY'])(
    'คืน undefined สำหรับการแจ้งเตือนระดับกล่อง: %s',
    (message) => {
      expect(deriveProbeChannel(message)).toBeUndefined();
    },
  );

  it.each(['', 'GARBAGE/ON', 'PROBE/ON'])(
    'คืน undefined แทนที่จะส่ง head ดิบ ๆ ไปสร้าง probe ขยะ: %s',
    (message) => {
      expect(deriveProbeChannel(message)).toBeUndefined();
    },
  );
});

describe('NotificationConsumerController', () => {
  let controller: NotificationConsumerController;
  let notification: { create: jest.Mock };
  let ack: jest.Mock;
  let nack: jest.Mock;

  const ctx = () =>
    ({
      getChannelRef: () => ({ ack, nack }),
      getMessage: () => ({}),
    }) as unknown as RmqContext;

  beforeEach(() => {
    notification = { create: jest.fn().mockResolvedValue(undefined) };
    ack = jest.fn();
    nack = jest.fn();
    controller = new NotificationConsumerController(
      notification as unknown as NotificationService,
      new TraceService(),
      createMetricsMock(),
    );
  });

  it('แปลง payload ของ legacy แล้วเรียก notification.create พร้อม probe ที่ derive มา', async () => {
    await controller.handleDeviceNotification(
      {
        id: 'legacy-uuid',
        serial: 'SN-1',
        message: 'PROBE1/DOOR1/ON',
        detail: 'PROBE1: The door has been open for more than 15 minutes.',
        status: false,
        createAt: '2026-08-01T00:00:00.000Z',
      },
      ctx(),
    );

    expect(notification.create).toHaveBeenCalledWith({
      serial: 'SN-1',
      message: 'PROBE1/DOOR1/ON',
      detail: 'PROBE1: The door has been open for more than 15 minutes.',
      probe: '1',
    });
    expect(ack).toHaveBeenCalled();
    expect(nack).not.toHaveBeenCalled();
  });

  it('ไม่ผูก probe กับการแจ้งเตือนระดับกล่อง', async () => {
    await controller.handleDeviceNotification(
      { serial: 'SN-1', message: 'AC/OFF', detail: 'Power off' },
      ctx(),
    );
    expect(notification.create).toHaveBeenCalledWith(expect.objectContaining({ probe: undefined }));
    expect(ack).toHaveBeenCalled();
  });

  it('nack แบบไม่ requeue เมื่อ create ล้มเหลว', async () => {
    notification.create.mockRejectedValue(new Error('db down'));
    await controller.handleDeviceNotification({ serial: 'SN-1', message: 'AC/OFF' }, ctx());
    expect(nack).toHaveBeenCalledWith({}, false, false);
    expect(ack).not.toHaveBeenCalled();
  });

  it('nack payload ที่ขาด message แทนที่จะค้าง unacked', async () => {
    await controller.handleDeviceNotification({ serial: 'SN-1' }, ctx());
    expect(notification.create).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledWith({}, false, false);
    expect(ack).not.toHaveBeenCalled();
  });
});
