import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayloadDto } from '../dto/payload.dto';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get<string>('jwtSecret') ?? '',
      ignoreExpiration: false,
    });
  }

  async validate(payload: any): Promise<JwtPayloadDto> {
    return { id: payload.id, name: payload.name, role: payload.role, wardId: payload.wardId };
  }
}
