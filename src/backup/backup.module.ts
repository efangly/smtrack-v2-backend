import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { ObjectStorageService } from './object-storage.service';
import { ArchiveExportService } from './archive-export.service';
import { ArchiveRestoreService } from './archive-restore.service';
import { ArchiveController } from './archive.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AppConfig } from '../config/configuration';

import { PG_POOL } from './backup.tokens';

// token ย้ายไป backup.tokens.ts แล้วเพื่อตัด circular import — re-export ไว้ให้ของเดิมที่อ้างถึงยังใช้ได้
export { PG_POOL };

/**
 * ใช้ pg Pool แยกจาก Prisma เฉพาะงาน COPY (Prisma ไม่รองรับ COPY protocol)
 * pool เล็กๆ 2 connection พอ เพราะงาน archive ไม่ได้รันพร้อมกันเยอะ
 */
@Module({
  imports: [PrismaModule],
  controllers: [ArchiveController],
  providers: [
    ObjectStorageService,
    ArchiveExportService,
    ArchiveRestoreService,
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig>) =>
        new Pool({
          connectionString: config.get('databaseUrl', { infer: true }),
          max: 2,
          application_name: 'smtrack-log-archive',
        }),
    },
  ],
  exports: [ArchiveRestoreService],
})
export class BackupModule {}
