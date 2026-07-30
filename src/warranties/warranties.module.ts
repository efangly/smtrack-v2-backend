import { Module } from '@nestjs/common';
import { WarrantiesController } from './warranties.controller';
import { WarrantiesService } from './warranties.service';

@Module({
  controllers: [WarrantiesController],
  providers: [WarrantiesService],
  exports: [WarrantiesService],
})
export class WarrantiesModule {}
