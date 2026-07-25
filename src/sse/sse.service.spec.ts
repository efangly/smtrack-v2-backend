import { MessageEvent } from '@nestjs/common';
import { take, toArray } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';
import { SseService } from './sse.service';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { DeviceAssignmentService } from '../device/device-assignment.service';
import { MetricsService } from '../observability/metrics.service';
import { createMetricsMock } from '../observability/testing';

const userIn = (role: string, wardId = 'OPD'): JwtPayloadDto => ({
  id: 'u1',
  name: 'ผู้ใช้ทดสอบ',
  role,
  wardId,
});

/** role ที่เห็นทุก ward */
const SUPER = userIn('SUPER');
/** role ที่เห็นเฉพาะ ward ตัวเอง */
const WARD_USER = userIn('USER', 'OPD');

describe('SseService', () => {
  let service: SseService;
  let metrics: jest.Mocked<MetricsService>;
  let assignments: { resolveWard: jest.Mock };

  beforeEach(() => {
    metrics = createMetricsMock();
    assignments = { resolveWard: jest.fn().mockResolvedValue('OPD') };
    service = new SseService(metrics, assignments as unknown as DeviceAssignmentService);
  });

  it('subscribe stream แล้วได้รับเฉพาะ event ของ channel ที่ระบุ', async () => {
    const collected = firstValueFrom(
      service.streamFor('notification', SUPER).pipe(take(1), toArray()),
    );

    // ยิง telemetry ก่อน (ควรถูก filter ทิ้ง) แล้วตามด้วย notification
    service.broadcast('telemetry', { serial: 'X' });
    service.broadcast('notification', { id: 'n1' });

    const events = (await collected) as MessageEvent[];
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('notification');
    expect(events[0].data).toEqual({ id: 'n1' });
  });

  it('handleTelemetryCreated broadcast เข้า channel telemetry พร้อม ward ที่ resolve ได้', async () => {
    const collected = firstValueFrom(
      service.streamFor('telemetry', WARD_USER).pipe(take(1), toArray()),
    );
    await service.handleTelemetryCreated({ serial: 'SN-1' });

    const events = (await collected) as MessageEvent[];
    expect(assignments.resolveWard).toHaveBeenCalledWith('SN-1');
    expect(events[0].data).toEqual({ serial: 'SN-1' });
    expect(events[0].type).toBe('telemetry');
  });

  it('handleNotificationCreated broadcast เข้า channel notification', async () => {
    const collected = firstValueFrom(
      service.streamFor('notification', SUPER).pipe(take(1), toArray()),
    );
    await service.handleNotificationCreated({ id: 'n2', serial: 'SN-1' });
    const events = (await collected) as MessageEvent[];
    expect(events[0].data).toEqual({ id: 'n2', serial: 'SN-1' });
  });

  it('handleDeviceChanged broadcast เข้า channel device', async () => {
    const collected = firstValueFrom(service.streamFor('device', SUPER).pipe(take(1), toArray()));
    service.handleDeviceChanged({
      action: 'online',
      deviceId: 'd1',
      staticName: 'OPD-01',
      serial: 'SN-1',
      device: { id: 'd1', ward: 'OPD' } as never,
      at: new Date().toISOString(),
    });

    const events = (await collected) as MessageEvent[];
    expect(events[0].type).toBe('device');
    expect((events[0].data as { action: string }).action).toBe('online');
    // ward มากับ payload อยู่แล้ว ไม่ต้องยิง resolve ซ้ำ
    expect(assignments.resolveWard).not.toHaveBeenCalled();
  });

  it('streamForChannels ได้เฉพาะ channel ที่ขอ บน connection เดียว', async () => {
    const collected = firstValueFrom(
      service.streamForChannels(['device', 'telemetry'], SUPER).pipe(take(2), toArray()),
    );

    service.broadcast('notification', { id: 'n1' }); // ไม่ได้ขอ ต้องถูก filter ทิ้ง
    service.broadcast('device', { action: 'offline' });
    service.broadcast('telemetry', { serial: 'SN-1' });

    const events = (await collected) as MessageEvent[];
    expect(events.map((e) => e.type)).toEqual(['device', 'telemetry']);
  });

  it('role ที่ถูก scope ได้รับเฉพาะ event ของ ward ตัวเอง', async () => {
    const collected = firstValueFrom(
      service.streamFor('telemetry', WARD_USER).pipe(take(1), toArray()),
    );

    service.broadcast('telemetry', { serial: 'ICU-1' }, 'ICU'); // ward อื่น
    service.broadcast('telemetry', { serial: 'OPD-1' }, 'OPD');

    const events = (await collected) as MessageEvent[];
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ serial: 'OPD-1' });
  });

  it('event ที่ resolve ward ไม่ได้ ถูกซ่อนจาก role ที่ถูก scope แต่ role อื่นยังเห็น', async () => {
    const scoped: MessageEvent[] = [];
    const sub = service.streamFor('telemetry', WARD_USER).subscribe((e) => scoped.push(e));
    const unscoped = firstValueFrom(service.streamFor('telemetry', SUPER).pipe(take(1), toArray()));

    service.broadcast('telemetry', { serial: 'ไม่รู้จัก' }, null);

    expect(((await unscoped) as MessageEvent[])[0].data).toEqual({ serial: 'ไม่รู้จัก' });
    expect(scoped).toHaveLength(0);
    sub.unsubscribe();
  });

  it('streamForChannels นับ connection ครั้งเดียวต่อ connection ไม่ใช่ต่อ channel', () => {
    const sub = service
      .streamForChannels(['device', 'telemetry', 'notification'], SUPER)
      .subscribe();
    expect(metrics.sseConnectionOpened).toHaveBeenCalledTimes(1);
    expect(metrics.sseConnectionOpened).toHaveBeenCalledWith('multi');

    sub.unsubscribe();
    expect(metrics.sseConnectionClosed).toHaveBeenCalledTimes(1);
    expect(metrics.sseConnectionClosed).toHaveBeenCalledWith('multi');
  });

  it('นับ connection ขึ้นตอน subscribe และลงตอน unsubscribe', () => {
    const sub = service.streamFor('telemetry', SUPER).subscribe();
    expect(metrics.sseConnectionOpened).toHaveBeenCalledWith('telemetry');
    expect(metrics.sseConnectionClosed).not.toHaveBeenCalled();

    sub.unsubscribe();
    expect(metrics.sseConnectionClosed).toHaveBeenCalledWith('telemetry');
  });
});
