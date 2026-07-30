import { IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { Day } from '../../generated/prisma/client';

export class CreateProbeDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  type?: string;

  @IsString()
  @IsOptional()
  channel?: string;

  @IsNumber()
  @IsOptional()
  tempMin?: number;

  @IsNumber()
  @IsOptional()
  tempMax?: number;

  @IsNumber()
  @IsOptional()
  humiMin?: number;

  @IsNumber()
  @IsOptional()
  humiMax?: number;

  @IsNumber()
  @IsOptional()
  tempAdj?: number;

  @IsNumber()
  @IsOptional()
  humiAdj?: number;

  @IsString()
  @IsOptional()
  stampTime?: string;

  @IsInt()
  @IsOptional()
  doorQty?: number;

  @IsString()
  @IsOptional()
  position?: string;

  @IsString()
  @IsOptional()
  muteAlarmDuration?: string;

  @IsBoolean()
  @IsOptional()
  doorSound?: boolean;

  @IsString()
  @IsOptional()
  doorAlarmTime?: string;

  @IsString()
  @IsOptional()
  muteDoorAlarmDuration?: string;

  @IsInt()
  @IsOptional()
  notiDelay?: number;

  @IsBoolean()
  @IsOptional()
  notiToNormal?: boolean;

  @IsBoolean()
  @IsOptional()
  notiMobile?: boolean;

  @IsInt()
  @IsOptional()
  notiRepeat?: number;

  @IsEnum(Day)
  @IsOptional()
  firstDay?: Day;

  @IsEnum(Day)
  @IsOptional()
  secondDay?: Day;

  @IsEnum(Day)
  @IsOptional()
  thirdDay?: Day;

  @IsString()
  @IsOptional()
  firstTime?: string;

  @IsString()
  @IsOptional()
  secondTime?: string;

  @IsString()
  @IsOptional()
  thirdTime?: string;

  // ไม่รับ deviceId จาก body — มาจาก route param `:deviceId` เท่านั้น (ดู probe.controller.ts)
}
