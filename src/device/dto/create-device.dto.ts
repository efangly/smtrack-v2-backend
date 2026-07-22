import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateDeviceDto {
  @IsString()
  @IsNotEmpty()
  serial!: string;

  @IsString()
  @IsNotEmpty()
  ward!: string;

  @IsString()
  @IsNotEmpty()
  staticName!: string;

  @IsString()
  @IsOptional()
  name?: string;

  @IsBoolean()
  status!: boolean;

  @IsInt()
  seq!: number;

  @IsString()
  @IsNotEmpty()
  firmware!: string;

  @IsString()
  @IsOptional()
  remark?: string;

  @IsString()
  @IsOptional()
  position?: string;

  @IsString()
  @IsOptional()
  positionPic?: string;
}
