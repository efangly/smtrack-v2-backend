import { IsString, MaxLength } from 'class-validator';

export class DevicePayloadDto {
  @IsString()
  @MaxLength(150)
  sn: string;
}
