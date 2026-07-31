import { Module } from '@nestjs/common';
import { FirmwareController } from './firmware.controller';
import { FirmwareService } from './firmware.service';
import { FirmwareStorageService } from './firmware-storage.service';

@Module({
  controllers: [FirmwareController],
  providers: [FirmwareService, FirmwareStorageService],
  exports: [FirmwareService],
})
export class FirmwareModule {}
