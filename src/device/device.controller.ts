import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Devices } from '../generated/prisma/client';
import { DeviceService } from './device.service';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';

// หมายเหตุ: ไม่ guard controller นี้ เพื่อคงพฤติกรรมเดิมของ smtrack-log (device controller ไม่มี guard)
@ApiTags('devices')
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

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDeviceDto): Promise<Devices> {
    return this.deviceService.update(id, dto);
  }
}
