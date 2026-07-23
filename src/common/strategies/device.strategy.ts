import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { DevicePayloadDto } from '../dto/device-payload.dto';

@Injectable()
export class DeviceStrategy extends PassportStrategy(Strategy, 'device-jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get<string>('deviceSecret') ?? '',
      ignoreExpiration: false,
    });
  }

  async validate(payload: any): Promise<DevicePayloadDto> {
    return { sn: payload.sn };
  }
}
