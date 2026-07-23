import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from '../common/strategies/jwt.strategy';
import { DeviceStrategy } from '../common/strategies/device.strategy';

@Module({
  imports: [PassportModule],
  providers: [JwtStrategy, DeviceStrategy],
  exports: [PassportModule],
})
export class AuthModule {}
