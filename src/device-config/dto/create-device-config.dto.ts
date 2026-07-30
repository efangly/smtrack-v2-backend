import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateDeviceConfigDto {
  @IsBoolean()
  @IsOptional()
  dhcp?: boolean;

  @IsString()
  @IsOptional()
  ip?: string;

  @IsString()
  @IsOptional()
  mac?: string;

  @IsString()
  @IsOptional()
  subnet?: string;

  @IsString()
  @IsOptional()
  gateway?: string;

  @IsString()
  @IsOptional()
  dns?: string;

  @IsBoolean()
  @IsOptional()
  dhcpEth?: boolean;

  @IsString()
  @IsOptional()
  ipEth?: string;

  @IsString()
  @IsOptional()
  macEth?: string;

  @IsString()
  @IsOptional()
  subnetEth?: string;

  @IsString()
  @IsOptional()
  gatewayEth?: string;

  @IsString()
  @IsOptional()
  dnsEth?: string;

  @IsString()
  @IsOptional()
  ssid?: string;

  @IsString()
  @IsOptional()
  password?: string;

  @IsString()
  @IsOptional()
  simSP?: string;

  @IsString()
  @IsOptional()
  email1?: string;

  @IsString()
  @IsOptional()
  email2?: string;

  @IsString()
  @IsOptional()
  email3?: string;

  @IsString()
  @IsOptional()
  hardReset?: string;

  // ไม่รับ deviceId จาก body — มาจาก route param `:deviceId` เท่านั้น (ดู device-config.controller.ts)
}
