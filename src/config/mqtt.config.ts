import { Transport, MqttOptions } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';

/**
 * สร้าง options สำหรับ MQTT microservice transport ของ NestJS
 * พร้อม reconnect/keepalive ที่เหมาะกับระบบ IoT ที่ connection หลุดบ่อย
 */
export const buildMqttOptions = (config: ConfigService): MqttOptions => ({
  transport: Transport.MQTT,
  options: {
    url: config.get<string>('mqtt.brokerUrl'),
    username: config.get<string>('mqtt.username'),
    password: config.get<string>('mqtt.password'),
    clientId: config.get<string>('mqtt.clientId'),
    // reconnect/keepalive
    reconnectPeriod: 5000,
    connectTimeout: 30 * 1000,
    keepalive: 60,
    clean: true,
    resubscribe: true,
  },
});
