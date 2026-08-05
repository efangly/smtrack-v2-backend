import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, IsDateString } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * เวลาที่อุปกรณ์/ต้นทางส่งมาโดยไม่ระบุ timezone เป็นเวลาท้องถิ่น Asia/Bangkok (UTC+7) เสมอ — ไม่ใช่ UTC
 *
 * `new Date("2026-08-01 10:00:00")` ตีความเป็น "เวลาท้องถิ่นของ server" ⇒ เวลาที่บันทึกจะ
 * เพี้ยนไปตาม TZ ของเครื่องที่รันแบบเงียบ ๆ โดยไม่มี error ให้ผนวก `+07:00` ตั้งแต่ชั้น DTO
 * เพื่อให้ทุกช่องทาง (MQTT / HTTP / RabbitMQ) แปลงเป็น UTC ตรงกันหมด (เดิมผนวก `Z` ตรง ๆ ซึ่งเพี้ยน
 * +7 ชั่วโมงเพราะ mark เวลาท้องถิ่นเป็น UTC ทั้งที่ไม่ใช่ — ทำให้ query ตามช่วงเวลา (graph/logday)
 * มองข้อมูลล่าสุดว่าอยู่ "อนาคต" แล้วกรองทิ้งไป)
 * ค่าที่ระบุ timezone มาแล้ว (`Z` หรือ `±HH:MM`) ปล่อยผ่านตามเดิม — ไทยไม่มี DST จึง offset คงที่ได้
 */
export function normalizeToUtcIso(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return trimmed;
  const isoish = trimmed.replace(' ', 'T');
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(isoish)
    ? `${isoish}+07:00`
    : value;
}

/**
 * payload log/telemetry จากอุปกรณ์ IoT — validate ก่อนเข้าสู่ business logic เสมอ
 * (payload จากอุปกรณ์เชื่อถือไม่ได้ 100%)
 */
export class CreateTelemetryDto {
  /**
   * optional ตรงนี้เพราะอุปกรณ์อาจส่งมาแต่ topic (devices/{serial}/log) โดยไม่ใส่ในตัว payload
   * — ValidationPipe ทำงานก่อน handler ถ้าบังคับ @IsNotEmpty จะปัดตกก่อนที่ controller
   * จะมีโอกาสเติม serial จาก topic ให้ การบังคับว่าต้องมีย้ายไปอยู่ที่ TelemetryService.ingest แทน
   */
  @IsString()
  @IsOptional()
  serial?: string;

  @IsNumber()
  @IsOptional()
  temp?: number;

  @IsNumber()
  @IsOptional()
  tempDisplay?: number;

  @IsNumber()
  @IsOptional()
  humidity?: number;

  @IsNumber()
  @IsOptional()
  humidityDisplay?: number;

  @Transform(({ value }) => normalizeToUtcIso(value))
  @IsDateString()
  @IsOptional()
  sendTime?: string;

  @IsBoolean()
  @IsOptional()
  plug?: boolean;

  @IsBoolean()
  @IsOptional()
  door1?: boolean;

  @IsBoolean()
  @IsOptional()
  door2?: boolean;

  @IsBoolean()
  @IsOptional()
  door3?: boolean;

  @IsBoolean()
  @IsOptional()
  internet?: boolean;

  @IsString()
  @IsOptional()
  probe?: string;

  /**
   * เปอร์เซ็นต์แบตเตอรี่ (0-100) — ต้นทาง legacy ประกาศเป็น `@IsNumber` จึงส่ง float มาได้
   * ปัดเป็นจำนวนเต็มแทนที่จะปัดข้อความทั้งก้อนตก เพราะเศษทศนิยมของ % ไม่มีความหมาย
   */
  @Transform(({ value }) => (typeof value === 'number' ? Math.round(value) : value))
  @IsInt()
  @IsOptional()
  battery?: number;

  @IsNumber()
  @IsOptional()
  tempInternal?: number;

  @IsBoolean()
  @IsOptional()
  extMemory?: boolean;
}
