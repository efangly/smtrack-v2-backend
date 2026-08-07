import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';

// ใช้ instance เดียวร่วมกันทุก consumer — ValidationPipe ไม่มี state ต่อ request
const pipe = new ValidationPipe({ transform: true, whitelist: true });

/**
 * validate payload ของ RabbitMQ ด้วยมือแทนการใส่ ValidationPipe ไว้ที่ `@Payload()`
 *
 * pipe ที่ผูกกับ parameter จะทำงาน "ก่อน" body ของ handler ⇒ ถ้า validate ไม่ผ่าน
 * exception จะโยนออกไปโดยที่ ackOrNack ยังไม่ถูกเรียกเลย ข้อความจึงค้าง unacked
 * แล้วถูก requeue วนไม่รู้จบ (แทนที่จะถูก nack ทิ้งตามเจตนาใน rmq-ack.util.ts)
 * เรียกจากข้างใน callback ของ ackOrNack แทน เพื่อให้ payload เสียถูกทิ้งจริง
 */
export function validatePayload<T>(cls: new () => T, payload: unknown): Promise<T> {
  return pipe.transform(payload, {
    type: 'body',
    metatype: cls,
  } as ArgumentMetadata) as Promise<T>;
}
