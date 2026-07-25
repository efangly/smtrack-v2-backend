// Prisma 7 ไม่โหลด .env ให้อัตโนมัติ — e2e ต้องโหลดเองก่อน AppModule ถูก import
import 'dotenv/config';

// เทสไม่ส่ง telemetry จริง — ปิด OTel SDK และลด log noise
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
process.env.LOG_LEVEL = 'silent';

// JWT_SECRET/DEVICE_SECRET ใน .env เป็นค่าว่าง (secret จริงไม่ถูก commit) ซึ่งทำให้ passport-jwt
// verify ไม่ผ่านเลยและทุก endpoint ที่มี guard ตอบ 401 — เทสจึงกำหนดค่าของตัวเองแบบ deterministic
// ใช้ ||= เพื่อให้ CI ที่ตั้ง secret มาแล้วยังใช้ค่าของตัวเองได้
process.env.JWT_SECRET ||= 'e2e-jwt-secret';
process.env.DEVICE_SECRET ||= 'e2e-device-secret';
