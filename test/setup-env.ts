// Prisma 7 ไม่โหลด .env ให้อัตโนมัติ — e2e ต้องโหลดเองก่อน AppModule ถูก import
import 'dotenv/config';

// เทสไม่ส่ง telemetry จริง — ปิด OTel SDK และลด log noise
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
process.env.LOG_LEVEL = 'silent';
