/**
 * DI token ของ backup module
 *
 * แยกออกมาไว้ไฟล์นี้เพื่อตัด circular import: ถ้าประกาศไว้ใน backup.module.ts
 * ตัว service จะต้อง import กลับไปหา module ที่ import service อยู่แล้ว
 * ทำให้ตอน @Inject(PG_POOL) ถูก evaluate ค่ายังเป็น undefined แล้ว Nest resolve ไม่ได้
 */
export const PG_POOL = Symbol('PG_POOL');
