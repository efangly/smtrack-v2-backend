import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class DeviceJwtAuthGuard extends AuthGuard('device-jwt') {}
