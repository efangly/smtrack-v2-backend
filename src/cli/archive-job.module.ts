import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration';
import { PrismaModule } from '../prisma/prisma.module';
import { BackupModule } from '../backup/backup.module';

/**
 * module แบบเบาสำหรับ CLI ของ CronJob — ไม่ดึง AppModule ทั้งก้อนเข้ามา
 * (ไม่ต้องต่อ MQTT / RabbitMQ / Redis / gRPC เพื่อ export ไฟล์ขึ้น S3)
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], cache: true }),
    PrismaModule,
    BackupModule,
  ],
})
export class ArchiveJobCliModule {}
