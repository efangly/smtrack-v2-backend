import { SetMetadata } from '@nestjs/common';

export const SKIP_INTERCEPTOR = 'skipInterceptor';

export const SkipInterceptor = () => SetMetadata(SKIP_INTERCEPTOR, true);
