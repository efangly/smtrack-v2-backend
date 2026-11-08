import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * ข้อมูลที่ขออยู่นอก hot window และกำลัง on-demand restore จาก archive อยู่ แต่ยังไม่เสร็จภายในเวลาที่รอ
 * ตอบ 202 + Retry-After ให้ client ยิงซ้ำ (HttpExceptionFilter เป็นคนใส่ header)
 */
export class RestoreInProgressException extends HttpException {
  constructor(
    readonly retryAfterSeconds: number,
    message = 'ข้อมูลช่วงนี้อยู่ใน archive กำลังนำกลับมา กรุณาลองใหม่อีกครั้ง',
  ) {
    super({ message, retryAfterSeconds }, HttpStatus.ACCEPTED);
  }
}
