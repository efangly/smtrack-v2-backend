import { IsBoolean, IsDateString, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateWarrantyDto {
  @IsString()
  @IsNotEmpty()
  serial!: string;

  @IsString()
  @IsOptional()
  devName?: string;

  @IsString()
  @IsOptional()
  product?: string;

  @IsString()
  @IsOptional()
  model?: string;

  @IsString()
  @IsOptional()
  installDate?: string;

  @IsString()
  @IsOptional()
  customerName?: string;

  @IsString()
  @IsOptional()
  customerAddress?: string;

  @IsString()
  @IsOptional()
  saleDepartment?: string;

  @IsString()
  @IsOptional()
  invoice?: string;

  @IsDateString()
  @IsOptional()
  expire?: string;

  @IsBoolean()
  @IsOptional()
  status?: boolean;

  @IsString()
  @IsOptional()
  note?: string;
}
