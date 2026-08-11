import { Body, Controller, Get, Param, Patch, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Configs, Devices, Probes } from '../generated/prisma/client';
import { AdjustService, AdjustSnapshot } from './adjust.service';
import { UpdateProbeDto } from '../probe/dto/update-probe.dto';
import { UpdateDeviceConfigDto } from '../device-config/dto/update-device-config.dto';
import { UpdateAdjustDeviceDto } from './dto/update-adjust-device.dto';

// หมายเหตุ: ทุก route ในคอนโทรลเลอร์นี้ตั้งใจไม่ใส่ @UseGuards เลย — อุปกรณ์ IoT ในสนามไม่มี
// credential ที่ใช้งานได้จริง (มีแค่ shared-secret device-jwt สำหรับ POST log/notification)
// จึงต้องเปิดให้ GET/PUT/PATCH ค่าตั้งค่าของตัวเองได้แบบไม่ auth เหมือน GET ใน device.controller.ts
@ApiTags('adjust')
@Controller('adjust')
export class AdjustController {
  constructor(private readonly adjustService: AdjustService) {}

  @Get(':serial')
  getSnapshot(@Param('serial') serial: string): Promise<AdjustSnapshot> {
    return this.adjustService.getSnapshot(serial);
  }

  @Put(':serial/probe/:channel')
  updateProbe(
    @Param('serial') serial: string,
    @Param('channel') channel: string,
    @Body() dto: UpdateProbeDto,
  ): Promise<Probes> {
    return this.adjustService.updateProbe(serial, channel, dto);
  }

  @Patch(':serial/config')
  updateConfig(
    @Param('serial') serial: string,
    @Body() dto: UpdateDeviceConfigDto,
  ): Promise<Configs> {
    return this.adjustService.updateConfig(serial, dto);
  }

  @Patch(':serial')
  updateDevice(
    @Param('serial') serial: string,
    @Body() dto: UpdateAdjustDeviceDto,
  ): Promise<Devices> {
    return this.adjustService.updateDevice(serial, dto);
  }
}
