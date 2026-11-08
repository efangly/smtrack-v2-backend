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
    // clean=true เป็น default โดยตั้งใจ: clientId เปลี่ยนทุกครั้งที่ pod ถูกสร้างใหม่ ถ้า clean=false
    // broker จะเก็บ session ของ pod ที่ตายไปแล้วไว้ และใน shared subscription message อาจถูกแบ่ง
    // ไปค้างใน session นั้นจนหาย — กัน log หายช่วง deploy ด้วย ≥2 replica + rolling update แทน
    // ตั้ง MQTT_CLEAN_SESSION=false ได้เฉพาะเมื่อ MQTT_INSTANCE_ID คงที่ต่อ instance (เช่น StatefulSet)
    clean: config.get<boolean>('mqtt.cleanSession') ?? true,
    resubscribe: true,
  },
});
