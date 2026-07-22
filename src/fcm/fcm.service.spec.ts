import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FcmService } from './fcm.service';

describe('FcmService', () => {
  let service: FcmService;
  let send: jest.Mock;

  beforeEach(async () => {
    send = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [FcmService, { provide: ConfigService, useValue: { get: () => 'set' } }],
    }).compile();

    service = module.get(FcmService);
    // inject fake firebase app แทน onModuleInit (ไม่ยิง firebase จริง)
    (service as any).app = { messaging: () => ({ send }) };
  });

  it('broadcast ไป topic ของ serial ครั้งเดียว (ไม่วนราย token)', async () => {
    send.mockResolvedValue('msg-1');

    const result = await service.pushToSerial('SN-1', { title: 'a', body: 'b' }, { k: 'v' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      topic: 'device_SN-1',
      notification: { title: 'a', body: 'b' },
      data: { k: 'v' },
    });
    expect(result).toEqual({ topic: 'device_SN-1', sent: true, messageId: 'msg-1' });
  });

  it('sanitize อักขระที่ topic name ไม่รองรับ', async () => {
    send.mockResolvedValue('msg-2');
    const result = await service.pushToSerial('SN/1 A', { title: 'a', body: 'b' });
    expect(result.topic).toBe('device_SN_1_A');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ topic: 'device_SN_1_A' }));
  });

  it('ส่งล้มเหลว → sent=false ไม่ throw', async () => {
    send.mockRejectedValue({ code: 'messaging/internal-error' });
    const result = await service.pushToSerial('SN-1', { title: 'a', body: 'b' });
    expect(result).toEqual({ topic: 'device_SN-1', sent: false });
  });

  it('firebase ไม่ init → ข้าม broadcast', async () => {
    (service as any).app = undefined;
    const result = await service.pushToSerial('SN-1', { title: 'a', body: 'b' });
    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ topic: 'device_SN-1', sent: false });
  });
});
