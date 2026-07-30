import { PartialType } from '@nestjs/swagger';
import { CreateDeviceConfigDto } from './create-device-config.dto';

export class UpdateDeviceConfigDto extends PartialType(CreateDeviceConfigDto) {}
