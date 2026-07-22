import { Module } from '@nestjs/common';
import { CacheInvalidationListener } from './cache-invalidation.listener';

@Module({
  providers: [CacheInvalidationListener],
})
export class CacheModule {}
