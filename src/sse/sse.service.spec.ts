import { ForbiddenException, MessageEvent } from '@nestjs/common';
import { take, toArray } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';
import { SseService } from './sse.service';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { DeviceAssignmentService } from '../device/device-assignment.service';
import { MetricsService } from '../observability/metrics.service';
import { createMetricsMock } from '../observability/testing';
import { PrismaService } from '../prisma/prisma.service';

/** ผู้ใช้ใน tenant T1 — departments 'ALL' = เห็นทั้ง tenant (เช่น ADMIN) */
const userIn = (role: string, departments: 'ALL' | string[] = ['OPD']): JwtPayloadDto => ({
  id: 'u1',
  name: 'ผู้ใช้ทดสอบ',
  role,
  scope: role === 'SUPER' ? { kind: 'GLOBAL' } : { kind: 'TENANT', tenantId: 'T1', departments },
});

/** ตำแหน่งของ event ใน tenant/department */
const at = (departmentId: string, tenantId = 'T1') => ({ tenantId, departmentId });

/** role ที่เห็นทุก department */
const SUPER = userIn('SUPER');
/** role ที่เห็นเฉพาะ department ที่ตัวเองผูกอยู่ */
const DEPT_USER = userIn('USER', ['OPD']);

describe('SseService', () => {
  let service: SseService;
  let metrics: jest.Mocked<MetricsService>;
  let assignments: { resolveLocation: jest.Mock };
  let prisma: { logDays: { findFirst: jest.Mock } };

  beforeEach(() => {
    metrics = createMetricsMock();
    assignments = { resolveLocation: jest.fn().mockResolvedValue(at('OPD')) };
    prisma = { logDays: { findFirst: jest.fn().mockResolvedValue(null) } };
    service = new SseService(
      metrics,
      assignments as unknown as DeviceAssignmentService,
      prisma as unknown as PrismaService,
    );
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

  it('handleTelemetryCreated broadcast เข้า channel telemetry พร้อมตำแหน่งที่ resolve ได้', async () => {
    const collected = firstValueFrom(
      service.streamFor('telemetry', DEPT_USER).pipe(take(1), toArray()),
    );
    await service.handleTelemetryCreated({ serial: 'SN-1' });

    const events = (await collected) as MessageEvent[];
    expect(assignments.resolveLocation).toHaveBeenCalledWith('SN-1');
    expect(events[0].data).toEqual({ serial: 'SN-1' });
    expect(events[0].type).toBe('telemetry');
  });

  it('handleDeviceChanged broadcast เข้า channel device', async () => {
    const collected = firstValueFrom(service.streamFor('device', SUPER).pipe(take(1), toArray()));
    service.handleDeviceChanged({
      action: 'online',
      deviceId: 'd1',
      staticName: 'OPD-01',
      serial: 'SN-1',
      device: { id: 'd1', tenantId: 'T1', departmentId: 'OPD' } as never,
      at: new Date().toISOString(),
    });

    const events = (await collected) as MessageEvent[];
    expect(events[0].type).toBe('device');
    expect((events[0].data as { action: string }).action).toBe('online');
    // department มากับ payload อยู่แล้ว ไม่ต้องยิง resolve ซ้ำ
    expect(assignments.resolveLocation).not.toHaveBeenCalled();
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

  it('role ที่ถูก scope ได้รับเฉพาะ event ของ department ตัวเอง', async () => {
    const collected = firstValueFrom(
      service.streamFor('telemetry', DEPT_USER).pipe(take(1), toArray()),
    );

    service.broadcast('telemetry', { serial: 'ICU-1' }, at('ICU')); // department อื่น
    service.broadcast('telemetry', { serial: 'OPD-T2' }, at('OPD', 'T2')); // ชื่อเดียวกันแต่คนละ tenant
    service.broadcast('telemetry', { serial: 'OPD-1' }, at('OPD'));

    const events = (await collected) as MessageEvent[];
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ serial: 'OPD-1' });
  });

  it('user ที่ผูกหลาย department ได้รับ event ของทุก department ที่ผูก แต่ไม่ใช่ department อื่น', async () => {
    const received: MessageEvent[] = [];
    const sub = service
      .streamFor('telemetry', userIn('USER', ['OPD', 'ICU']))
      .subscribe((e) => received.push(e));

    service.broadcast('telemetry', { serial: 'OPD-1' }, at('OPD'));
    service.broadcast('telemetry', { serial: 'ER-1' }, at('ER'));
    service.broadcast('telemetry', { serial: 'ICU-1' }, at('ICU'));
    sub.unsubscribe();

    expect(received.map((e) => e.data)).toEqual([{ serial: 'OPD-1' }, { serial: 'ICU-1' }]);
  });

  it('user ที่ไม่ผูก department ใดเลยไม่ได้รับ event ใด ๆ', () => {
    const received: MessageEvent[] = [];
    const sub = service
      .streamFor('telemetry', userIn('USER', []))
      .subscribe((e) => received.push(e));

    service.broadcast('telemetry', { serial: 'OPD-1' }, at('OPD'));
    sub.unsubscribe();

    expect(received).toHaveLength(0);
  });

  it('ผู้ที่เห็นทั้ง tenant (ADMIN) ได้ทุก department ของ tenant ตัวเอง แต่ไม่ได้ของ tenant อื่น', () => {
    const received: MessageEvent[] = [];
    const sub = service
      .streamFor('telemetry', userIn('ADMIN', 'ALL'))
      .subscribe((e) => received.push(e));

    service.broadcast('telemetry', { serial: 'ER-1' }, at('ER'));
    service.broadcast('telemetry', { serial: 'OPD-T2' }, at('OPD', 'T2'));
    service.broadcast('telemetry', { serial: 'ICU-1' }, at('ICU'));
    sub.unsubscribe();

    expect(received.map((e) => e.data)).toEqual([{ serial: 'ER-1' }, { serial: 'ICU-1' }]);
  });

  describe('unreadCount ต่อผู้รับ', () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    it('user ที่ถูก scope ได้ unreadCount ตาม department ทั้งหมดของตัวเอง ไม่ใช่ของ department ที่เกิด event', async () => {
      const counter = jest.fn().mockResolvedValue(9);
      service.registerUnreadCounter(counter);
      const user = userIn('USER', ['OPD', 'ICU']);
      const collected = firstValueFrom(service.streamFor('notification', user).pipe(take(1)));

      service.broadcast('notification', { id: 'n1', unreadCount: 2 }, at('OPD'));

      expect((await collected).data).toEqual({ id: 'n1', unreadCount: 9 });
      expect(counter).toHaveBeenCalledWith(user);
    });

    it('subscriber ที่ชุด department เดียวกันใช้การนับครั้งเดียวต่อ event', async () => {
      const counter = jest.fn().mockResolvedValue(3);
      service.registerUnreadCounter(counter);
      const a = firstValueFrom(
        service.streamFor('notification', userIn('USER', ['OPD', 'ICU'])).pipe(take(1)),
      );
      const b = firstValueFrom(
        service.streamFor('notification', userIn('USER', ['ICU', 'OPD'])).pipe(take(1)),
      );

      service.broadcast('notification', { id: 'n1', unreadCount: 1 }, at('OPD'));
      await Promise.all([a, b]);

      expect(counter).toHaveBeenCalledTimes(1);
    });

    it('ผู้ที่เห็นทั้ง tenant ก็ได้ยอดรวมของ tenant ไม่ใช่ของ department ที่เกิด event', async () => {
      const counter = jest.fn().mockResolvedValue(15);
      service.registerUnreadCounter(counter);
      const collected = firstValueFrom(
        service.streamFor('notification', userIn('ADMIN', 'ALL')).pipe(take(1)),
      );

      service.broadcast('notification', { id: 'n1', unreadCount: 2 }, at('OPD'));

      expect((await collected).data).toEqual({ id: 'n1', unreadCount: 15 });
    });

    it('GLOBAL ใช้ unreadCount ที่แนบมาเหมือนเดิม', async () => {
      const counter = jest.fn().mockResolvedValue(9);
      service.registerUnreadCounter(counter);
      const collected = firstValueFrom(service.streamFor('notification', SUPER).pipe(take(1)));

      service.broadcast('notification', { id: 'n1', unreadCount: 2 }, at('OPD'));

      expect((await collected).data).toEqual({ id: 'n1', unreadCount: 2 });
      expect(counter).not.toHaveBeenCalled();
    });

    it('นับไม่สำเร็จ ยังส่ง event ต่อด้วยค่าที่แนบมา', async () => {
      service.registerUnreadCounter(jest.fn().mockRejectedValue(new Error('db down')));
      const received: MessageEvent[] = [];
      const sub = service.streamFor('notification', DEPT_USER).subscribe((e) => received.push(e));

      service.broadcast('notification', { id: 'n1', unreadCount: 2 }, at('OPD'));
      await flush();
      sub.unsubscribe();

      expect(received.map((e) => e.data)).toEqual([{ id: 'n1', unreadCount: 2 }]);
    });
  });

  it('event ที่ไม่รู้ตำแหน่ง ถูกซ่อนจากผู้ที่ถูก scope แต่ GLOBAL ยังเห็น', async () => {
    const scoped: MessageEvent[] = [];
    const sub = service.streamFor('telemetry', DEPT_USER).subscribe((e) => scoped.push(e));
    const unscoped = firstValueFrom(service.streamFor('telemetry', SUPER).pipe(take(1), toArray()));

    service.broadcast('telemetry', { serial: 'ไม่รู้จัก' }, { tenantId: null, departmentId: null });

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

  describe('realtimeTemperatureStream', () => {
    /** defer(Promise) resolve ผ่าน microtask หลายชั้น — flush ด้วย macrotask boundary ให้ชัวร์ */
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    it('emit ค่าล่าสุดจาก DB ก่อน แล้วตามด้วย live event ที่ filter ตาม serial+channel', async () => {
      prisma.logDays.findFirst.mockResolvedValue({ temp: 20, sendTime: new Date('2026-01-01') });

      const obs = await service.realtimeTemperatureStream('SN-1', '2', SUPER);
      const events: MessageEvent[] = [];
      const sub = obs.subscribe((e) => events.push(e));
      await flush();

      // event ของ serial/channel อื่นต้องถูก filter ทิ้ง ก่อน event ที่ตรงจริง
      service.handleTelemetryRealtime({
        serial: 'SN-1',
        channel: '1',
        temp: 99,
        sendTime: new Date(),
      });
      service.handleTelemetryRealtime({
        serial: 'SN-2',
        channel: '2',
        temp: 99,
        sendTime: new Date(),
      });
      service.handleTelemetryRealtime({
        serial: 'SN-1',
        channel: '2',
        temp: 25.5,
        sendTime: new Date(),
      });
      sub.unsubscribe();

      expect(prisma.logDays.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { serial: 'SN-1', probe: '2' } }),
      );
      expect(events[0].data).toMatchObject({ temp: 20 });
      expect(events[1].data).toMatchObject({ serial: 'SN-1', channel: '2', temp: 25.5 });
    });

    it('ไม่ emit snapshot เริ่มต้นถ้าไม่มี log เก่าใน DB', async () => {
      prisma.logDays.findFirst.mockResolvedValue(null);
      const obs = await service.realtimeTemperatureStream('SN-1', '1', SUPER);
      const events: MessageEvent[] = [];
      const sub = obs.subscribe((e) => events.push(e));
      await flush();

      service.handleTelemetryRealtime({
        serial: 'SN-1',
        channel: '1',
        temp: 30,
        sendTime: new Date(),
      });
      sub.unsubscribe();

      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({ temp: 30 });
    });

    it('role ที่ถูก scope และไม่ได้ผูก department ของอุปกรณ์ถูกปฏิเสธ', async () => {
      assignments.resolveLocation.mockResolvedValue(at('ICU'));
      await expect(service.realtimeTemperatureStream('SN-1', '1', DEPT_USER)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('role ที่ถูก scope และผูก department ของอุปกรณ์ (หนึ่งในหลายอัน) เข้าถึงได้', async () => {
      assignments.resolveLocation.mockResolvedValue(at('ICU'));
      await expect(
        service.realtimeTemperatureStream('SN-1', '1', userIn('USER', ['OPD', 'ICU'])),
      ).resolves.toBeDefined();
    });

    it('user ที่ไม่ผูก department ใดเลยเปิด realtime ไม่ได้', async () => {
      await expect(
        service.realtimeTemperatureStream('SN-1', '1', userIn('USER', [])),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
