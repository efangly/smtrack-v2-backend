import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';

/**
 * JWT guard สำหรับ endpoint SSE โดยเฉพาะ — รับ token จาก `?token=` ได้ด้วย
 *
 * `EventSource` ของ browser ตั้ง header เองไม่ได้ ถ้าบังคับ Authorization header อย่างเดียว
 * frontend จะต่อ stream ไม่ได้เลย จึงยอมรับ query param เฉพาะ endpoint กลุ่มนี้
 * (ไม่ไปแก้ JwtStrategy ส่วนกลาง เพราะจะทำให้ทุก endpoint รับ token ทาง URL ตามไปด้วย
 * ซึ่ง URL มีโอกาสติดไปกับ access log / referrer)
 */
@Injectable()
export class SseAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const token = req.query?.token;

    // ย้าย query token ไปเป็น header ให้ passport-jwt ตัวเดิมอ่านต่อ — ไม่ต้องมี strategy ซ้ำ
    if (!req.headers.authorization && typeof token === 'string' && token.length > 0) {
      req.headers.authorization = `Bearer ${token}`;
    }
    return super.canActivate(context);
  }
}
