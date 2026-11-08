import { Module } from '@nestjs/common';
import { GraphService } from './graph.service';
import { GraphController } from './graph.controller';
import { DeviceModule } from '../device/device.module';
import { BackupModule } from '../backup/backup.module';

@Module({
  imports: [DeviceModule, BackupModule],
  controllers: [GraphController],
  providers: [GraphService],
  exports: [GraphService],
})
export class GraphModule {}
