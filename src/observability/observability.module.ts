import { Global, Module } from '@nestjs/common';
import { TraceService } from './trace.service';
import { MetricsService } from './metrics.service';

/** global เพราะ trace/metric ถูกเรียกจากแทบทุก vertical slice */
@Global()
@Module({
  providers: [TraceService, MetricsService],
  exports: [TraceService, MetricsService],
})
export class ObservabilityModule {}
