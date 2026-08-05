import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, IsDateString } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * เวลาที่อุปกรณ์/ต้นทางส่งมาเป็นเวลาท้องถิ่น Asia/Bangkok (UTC+7) เสมอ — ไม่ใช่ UTC แม้ตัว
 * payload บางรุ่นจะแปะ `Z` ต่อท้ายมาเองก็ตาม (ยืนยันจาก log จริง: device ส่ง
 * `"...T21:52:07.000Z"` ในขณะที่เวลา UTC จริงคือ `14:52:07Z` — ตัวเลขนาฬิกาที่ส่งมาคือเวลาไทย
 * ทั้งดุ้น เพียงแต่ firmware ใส่ `Z` ผิด ๆ ต่อท้ายเสมอ) ดังนั้นห้ามเชื่อ timezone suffix ที่
 * อุปกรณ์ส่งมาไม่ว่าจะมีหรือไม่มี — ต้องตัดทิ้งแล้วตีความตัวเลขนาฬิกาเป็นเวลาไทยใหม่ทุกครั้ง
 * ก่อนผนวก `+07:00` เพื่อแปลงเป็น UTC ที่ถูกต้อง ให้ทุกช่องทาง (MQTT / HTTP / RabbitMQ) ตรงกันหมด
 * ไทยไม่มี DST จึง offset คงที่ได้
 */
export function normalizeToUtcIso(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const withoutTz = trimmed.replace(/(?:Z|[+-]\d{2}:?\d{2})$/i, '');
  const isoish = withoutTz.replace(' ', 'T');
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
