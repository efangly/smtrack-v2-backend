import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Devices } from '../generated/prisma/client';
import { DeviceService } from './device.service';
import { CreateDeviceDto } from './dto/create-device.dto';

@Controller('devices')
export class DeviceController {
  constructor(private readonly deviceService: DeviceService) {}

  @Post()
  create(@Body() dto: CreateDeviceDto): Promise<Devices> {
    return this.deviceService.create(dto);
  }

  @Get()
  findAll(): Promise<Devices[]> {
    return this.deviceService.findAll();
  }

  @Get(':serial')
  findOne(@Param('serial') serial: string): Promise<Devices> {
    return this.deviceService.findOne(serial);
  }
}
