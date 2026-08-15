export interface AppConfig {
  port: number;
  corsOrigins: string[] | boolean;
  databaseUrl: string;
  mqtt: {
    brokerUrl: string;
    username?: string;
    password?: string;
    clientId: string;
    logTopic: string;
    /** topic realtime ~5s ไม่บันทึก DB — ใช้แค่ push ให้ sse ตอนปรับค่าชดเชย ยังไม่ได้ตกลง topic จริงกับฝั่ง firmware */
    realtimeTopic: string;
    notificationTopicPrefix: string;
  };
  redisUrl: string;
  rabbitmqUrl: string;
  rabbitmq: {
    deviceOnlineQueue: string;
    logQueue: string;
    fcmQueue: string;
  };
  jwtSecret: string;
  deviceSecret: string;
  archive: {
    retentionMonths: number;
    s3: {
      endpoint?: string;
      accessKey: string;
      secretKey: string;
      bucket: string;
      forcePathStyle: boolean;
      region: string;
    };
  };
  device: {
    s3: {
      endpoint?: string;
      accessKey: string;
      secretKey: string;
      bucket: string;
      forcePathStyle: boolean;
      region: string;
    };
  };
  firmware: {
    maxFileSize: number;
    s3: {
      endpoint?: string;
      accessKey: string;
      secretKey: string;
      bucket: string;
      forcePathStyle: boolean;
      region: string;
    };
  };
  observability: {
    serviceName: string;
    serviceVersion: string;
    environment: string;
    /** ไม่ตั้งค่า = ปิด OTel SDK ทั้งหมด (dev/test รันได้โดยไม่ต้องมี Collector) */
    otlpEndpoint?: string;
    logLevel: string;
  };
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  // CORS_ORIGIN ว่าง = เปิดรับทุก origin (สะดวกตอน dev local), ใส่ค่าเป็น comma-separated list เพื่อจำกัดตอน prod
  corsOrigins: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim())
    : true,
  databaseUrl: process.env.DATABASE_URL ?? '',
  mqtt: {
    brokerUrl: process.env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883',
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    clientId: process.env.MQTT_CLIENT_ID ?? 'nestjs-iot-service',
    logTopic: process.env.MQTT_LOG_TOPIC ?? 'devices/+/log',
    // TODO: กรอก topic จริงตามที่ตกลงกับฝั่ง firmware — ค่า default เป็นแค่ placeholder ตาม convention เดิม
    realtimeTopic: process.env.MQTT_REALTIME_TOPIC ?? 'devices/+/telemetry',
    notificationTopicPrefix: process.env.MQTT_NOTIFICATION_TOPIC_PREFIX ?? 'notification',
  },
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  rabbitmqUrl: process.env.RABBITMQ_URL ?? 'amqp://localhost:5672',
  rabbitmq: {
    deviceOnlineQueue: process.env.RABBITMQ_DEVICE_ONLINE_QUEUE ?? 'device_online_queue',
    logQueue: process.env.RABBITMQ_LOG_QUEUE ?? 'log_queue',
    fcmQueue: process.env.RABBITMQ_FCM_QUEUE ?? 'fcm_notification_queue',
  },
  jwtSecret: process.env.JWT_SECRET ?? '',
  deviceSecret: process.env.DEVICE_SECRET ?? '',
  archive: {
    retentionMonths: parseInt(process.env.ARCHIVE_RETENTION_MONTHS ?? '6', 10),
    s3: {
      endpoint: process.env.ARCHIVE_S3_ENDPOINT || undefined,
      accessKey: process.env.ARCHIVE_S3_ACCESS_KEY ?? '',
      secretKey: process.env.ARCHIVE_S3_SECRET_KEY ?? '',
      bucket: process.env.ARCHIVE_S3_BUCKET ?? 'smtrack-log-archive',
      forcePathStyle: process.env.ARCHIVE_S3_FORCE_PATH_STYLE === 'true',
      region: process.env.ARCHIVE_S3_REGION ?? 'us-east-1',
    },
  },
  // ถ้า MinIO/S3 เป็นตัวเดียวกับ archive (ต่างกันแค่ bucket) ไม่ต้องตั้ง DEVICE_S3_ENDPOINT/ACCESS_KEY/SECRET_KEY/REGION/FORCE_PATH_STYLE ซ้ำ
  // — จะ fallback ไปใช้ค่า ARCHIVE_S3_* ให้อัตโนมัติ ตั้งเฉพาะ DEVICE_S3_BUCKET ที่ต้องต่างกันจริง ๆ
  device: {
    s3: {
      endpoint: process.env.DEVICE_S3_ENDPOINT || process.env.ARCHIVE_S3_ENDPOINT || undefined,
      accessKey: process.env.DEVICE_S3_ACCESS_KEY || process.env.ARCHIVE_S3_ACCESS_KEY || '',
      secretKey: process.env.DEVICE_S3_SECRET_KEY || process.env.ARCHIVE_S3_SECRET_KEY || '',
      bucket: process.env.DEVICE_S3_BUCKET ?? 'smtrack-device-images',
      forcePathStyle:
        process.env.DEVICE_S3_FORCE_PATH_STYLE != null
          ? process.env.DEVICE_S3_FORCE_PATH_STYLE === 'true'
          : process.env.ARCHIVE_S3_FORCE_PATH_STYLE === 'true',
      region: process.env.DEVICE_S3_REGION || process.env.ARCHIVE_S3_REGION || 'us-east-1',
    },
  },
  // เหตุผลเดียวกับ device.s3 — ถ้าเป็น MinIO/S3 ตัวเดียวกับ archive ตั้งแค่ FIRMWARE_S3_BUCKET ก็พอ
  firmware: {
    maxFileSize: parseInt(process.env.FIRMWARE_MAX_FILE_SIZE ?? `${100 * 1024 * 1024}`, 10),
    s3: {
      endpoint: process.env.FIRMWARE_S3_ENDPOINT || process.env.ARCHIVE_S3_ENDPOINT || undefined,
      accessKey: process.env.FIRMWARE_S3_ACCESS_KEY || process.env.ARCHIVE_S3_ACCESS_KEY || '',
      secretKey: process.env.FIRMWARE_S3_SECRET_KEY || process.env.ARCHIVE_S3_SECRET_KEY || '',
      bucket: process.env.FIRMWARE_S3_BUCKET ?? 'smtrack-firmware',
      forcePathStyle:
        process.env.FIRMWARE_S3_FORCE_PATH_STYLE != null
          ? process.env.FIRMWARE_S3_FORCE_PATH_STYLE === 'true'
          : process.env.ARCHIVE_S3_FORCE_PATH_STYLE === 'true',
      region: process.env.FIRMWARE_S3_REGION || process.env.ARCHIVE_S3_REGION || 'us-east-1',
    },
  },
  // หมายเหตุ: tracing.ts รันก่อน Nest bootstrap จึงอ่าน process.env ตรง ไม่ผ่าน ConfigService
  // ส่วนนี้ไว้ให้ service อื่นอ้างอิงค่าเดียวกัน
  observability: {
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'smtrack-backend',
    serviceVersion: process.env.npm_package_version ?? '0.0.1',
    environment: process.env.NODE_ENV ?? 'development',
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    logLevel: process.env.LOG_LEVEL ?? 'info',
  },
});
