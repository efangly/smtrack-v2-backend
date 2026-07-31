import { Module } from '@nestjs/common';
import { ProbeController } from './probe.controller';
import { ProbeService } from './probe.service';
import { ProbeResolverService } from './probe-resolver.service';

@Module({
  controllers: [ProbeController],
  providers: [ProbeService, ProbeResolverService],
  exports: [ProbeService, ProbeResolverService],
})
export class ProbeModule {}
