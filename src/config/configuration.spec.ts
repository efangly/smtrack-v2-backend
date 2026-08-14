import configuration from './configuration';

describe('configuration — rabbitmq.fcmQueue', () => {
  const originalEnv = process.env.RABBITMQ_FCM_QUEUE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.RABBITMQ_FCM_QUEUE;
    } else {
      process.env.RABBITMQ_FCM_QUEUE = originalEnv;
    }
  });

  it('fallback เป็น fcm_notification_queue เมื่อไม่ตั้ง env', () => {
    delete process.env.RABBITMQ_FCM_QUEUE;
    expect(configuration().rabbitmq.fcmQueue).toBe('fcm_notification_queue');
  });

  it('อ่านค่าจาก RABBITMQ_FCM_QUEUE เมื่อตั้งไว้', () => {
    process.env.RABBITMQ_FCM_QUEUE = 'custom_fcm_queue';
    expect(configuration().rabbitmq.fcmQueue).toBe('custom_fcm_queue');
  });
});
