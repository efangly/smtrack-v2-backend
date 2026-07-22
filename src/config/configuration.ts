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
    notificationTopicPrefix: string;
  };
  redisUrl: string;
  rabbitmqUrl: string;
  jwtSecret: string;
  firebase: {
    projectId: string;
    clientEmail: string;
    privateKey: string;
  };
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
    notificationTopicPrefix: process.env.MQTT_NOTIFICATION_TOPIC_PREFIX ?? 'notification',
  },
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  rabbitmqUrl: process.env.RABBITMQ_URL ?? 'amqp://localhost:5672',
  jwtSecret: process.env.JWT_SECRET ?? '',
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID ?? '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? '',
    // env stores the key with literal \n — restore real newlines
    privateKey: (process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
  },
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
