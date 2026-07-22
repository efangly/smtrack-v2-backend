import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, IsDateString } from 'class-validator';

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
