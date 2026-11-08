import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { Day } from '../../generated/prisma/client';

/**
 * Snapshot "ทั้งแถว" ตาม schema ของระบบเดิม (smtrack-device) — ADR-0007, docs/legacy-sync-contract.md
 *
 * ทุก field ต้องประกาศไว้ เพราะ validatePayload ใช้ `whitelist: true` (field ที่ไม่ประกาศจะถูกตัดทิ้ง)
 * field ที่ nullable ในระบบเดิมเป็น @IsOptional — ค่า null/undefined ผ่านได้
 * วันที่มาเป็น ISO string ใน JSON → @Type(() => Date) แปลงให้
 */
abstract class LegacyRowDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @Type(() => Date)
  @IsDate()
  createAt!: Date;

  /** ตัวตัดสิน last-writer-wins — snapshot ที่ updateAt ไม่ใหม่กว่าที่ apply ไปแล้วจะถูกข้าม */
  @Type(() => Date)
  @IsDate()
  updateAt!: Date;
}

/** legacy `Devices` — `id` คือ serial ของกล่อง ส่วน `deviceId` คือ PK ของแถว (= จุดติดตั้ง) */
export class LegacyDeviceDto extends LegacyRowDto {
  @IsString()
  @IsNotEmpty()
  deviceId!: string;

  @IsString()
  @IsNotEmpty()
  staticName!: string;

  /** id ของ tenant ใน auth service (ADR-0004) */
  @IsString()
  @IsNotEmpty()
  hospital!: string;

  /** id ของ department ใน auth service (ADR-0004) */
  @IsString()
  @IsNotEmpty()
  ward!: string;

  @IsOptional() @IsString() name?: string | null;
  @IsBoolean() status!: boolean;
  @IsInt() seq!: number;
  @IsOptional() @IsString() location?: string | null;
  @IsOptional() @IsString() position?: string | null;
  @IsOptional() @IsString() positionPic?: string | null;
  @IsOptional() @Type(() => Date) @IsDate() installDate?: Date | null;
  @IsString() firmware!: string;
  @IsOptional() @IsString() remark?: string | null;
  @IsBoolean() online!: boolean;
  @IsOptional() @IsString() tag?: string | null;
  @IsOptional() @IsString() token?: string | null;
}

const DAYS = Object.values(Day);

export class LegacyProbeDto extends LegacyRowDto {
  /** serial ของกล่องที่ probe นี้ติดอยู่ */
  @IsString() @IsNotEmpty() sn!: string;
  @IsString() @IsNotEmpty() channel!: string;
  @IsOptional() @IsString() name?: string | null;
  @IsOptional() @IsString() type?: string | null;
  @IsNumber() tempMin!: number;
  @IsNumber() tempMax!: number;
  @IsNumber() humiMin!: number;
  @IsNumber() humiMax!: number;
  @IsNumber() tempAdj!: number;
  @IsNumber() humiAdj!: number;
  @IsOptional() @IsString() stampTime?: string | null;
  @IsInt() doorQty!: number;
  @IsOptional() @IsString() position?: string | null;
  @IsOptional() @IsString() muteAlarmDuration?: string | null;
  @IsBoolean() doorSound!: boolean;
  @IsOptional() @IsString() doorAlarmTime?: string | null;
  @IsOptional() @IsString() muteDoorAlarmDuration?: string | null;
  @IsInt() notiDelay!: number;
  @IsBoolean() notiToNormal!: boolean;
  @IsBoolean() notiMobile!: boolean;
  @IsInt() notiRepeat!: number;
  @IsIn(DAYS) firstDay!: Day;
  @IsIn(DAYS) secondDay!: Day;
  @IsIn(DAYS) thirdDay!: Day;
  @IsOptional() @IsString() firstTime?: string | null;
  @IsOptional() @IsString() secondTime?: string | null;
  @IsOptional() @IsString() thirdTime?: string | null;
}

export class LegacyConfigDto extends LegacyRowDto {
  @IsString() @IsNotEmpty() sn!: string;
  @IsBoolean() dhcp!: boolean;
  @IsOptional() @IsString() ip?: string | null;
  @IsOptional() @IsString() mac?: string | null;
  @IsOptional() @IsString() subnet?: string | null;
  @IsOptional() @IsString() gateway?: string | null;
  @IsOptional() @IsString() dns?: string | null;
  @IsOptional() @IsBoolean() dhcpEth?: boolean | null;
  @IsOptional() @IsString() ipEth?: string | null;
  @IsOptional() @IsString() macEth?: string | null;
  @IsOptional() @IsString() subnetEth?: string | null;
  @IsOptional() @IsString() gatewayEth?: string | null;
  @IsOptional() @IsString() dnsEth?: string | null;
  @IsOptional() @IsString() ssid?: string | null;
  @IsOptional() @IsString() password?: string | null;
  @IsOptional() @IsString() simSP?: string | null;
  @IsOptional() @IsString() email1?: string | null;
  @IsOptional() @IsString() email2?: string | null;
  @IsOptional() @IsString() email3?: string | null;
  @IsOptional() @IsString() hardReset?: string | null;
}

export class LegacyRepairDto extends LegacyRowDto {
  @IsInt() seq!: number;
  /** staticName ของจุดติดตั้ง — ระบบเดิมผูก repair กับจุดติดตั้งด้วยชื่อ ไม่ใช่ serial */
  @IsString() @IsNotEmpty() devName!: string;
  @IsOptional() @IsString() info?: string | null;
  @IsOptional() @IsString() info1?: string | null;
  @IsOptional() @IsString() info2?: string | null;
  @IsOptional() @IsString() address?: string | null;
  @IsOptional() @IsString() ward?: string | null;
  @IsOptional() @IsString() detail?: string | null;
  @IsOptional() @IsString() phone?: string | null;
  @IsOptional() @IsString() status?: string | null;
  @IsOptional() @IsString() warrantyStatus?: string | null;
  @IsOptional() @IsString() remark?: string | null;
}

export class LegacyWarrantyDto extends LegacyRowDto {
  @IsString() @IsNotEmpty() devName!: string;
  @IsOptional() @IsString() product?: string | null;
  @IsOptional() @IsString() model?: string | null;
  @IsOptional() @IsString() installDate?: string | null;
  @IsOptional() @IsString() customerName?: string | null;
  @IsOptional() @IsString() customerAddress?: string | null;
  @IsOptional() @IsString() saleDepartment?: string | null;
  @IsOptional() @IsString() invoice?: string | null;
  @Type(() => Date) @IsDate() expire!: Date;
  @IsBoolean() status!: boolean;
  @IsOptional() @IsString() note?: string | null;
}

/**
 * payload ของ `legacy.<entity>.deleted` — `id` คือ PK ของแถวในระบบเดิม
 * (สำหรับ device ใช้ `deviceId` เป็น PK และ `id` เป็น serial เหมือน snapshot)
 * `updateAt` = เวลาที่ลบ ใช้เทียบ LWW กับ upsert ที่อาจมาสลับลำดับ
 */
export class LegacyDeletedDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @Type(() => Date)
  @IsDate()
  updateAt!: Date;
}

export class LegacyDeviceDeletedDto extends LegacyDeletedDto {
  @IsString() @IsNotEmpty() deviceId!: string;
}
