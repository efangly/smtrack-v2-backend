import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayloadDto } from '../dto/payload.dto';
import { scopeFromClaims } from '../auth/access-scope';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get<string>('jwtSecret') ?? '',
      ignoreExpiration: false,
    });
  }

  /** จุดเดียวที่อ่าน claim ของ auth-service — payload เปลี่ยนเมื่อไรแก้ที่นี่กับ access-scope.ts */
  async validate(payload: any): Promise<JwtPayloadDto> {
    // auth-service ใส่ typ ทุก token และปฏิเสธ token ที่ไม่มี typ — ทำแบบเดียวกัน
    if (payload?.typ !== 'access') {
      throw new UnauthorizedException('invalid token type');
    }
    const scope = scopeFromClaims(payload);
    if (!scope) {
      throw new UnauthorizedException('token has no tenant');
    }
    return { id: payload.id, name: payload.name, role: payload.role, scope };
  }
}
