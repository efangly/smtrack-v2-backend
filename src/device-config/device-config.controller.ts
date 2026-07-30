import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Configs } from '../generated/prisma/client';
import { DeviceConfigService } from './device-config.service';
import { CreateDeviceConfigDto } from './dto/create-device-config.dto';
import { UpdateDeviceConfigDto } from './dto/update-device-config.dto';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { JwtPayloadDto } from '../common/dto/payload.dto';

// หมายเหตุ: GET route ไม่ guard เพื่อคงพฤติกรรมเดิมเหมือน device.controller.ts
// ส่วน create/update/delete guard ด้วย JwtAuthGuard + RolesGuard (SUPER/SERVICE/ADMIN)
// เหมือน device-repair เพราะกระทบ network setting ของอุปกรณ์โดยตรง
@ApiTags('device-config')
@Controller('devices/:deviceId/config')
export class DeviceConfigController {
  constructor(private readonly configService: DeviceConfigService) {}

  @Post()
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  create(
    @Param('deviceId') deviceId: string,
    @Body() dto: CreateDeviceConfigDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Configs> {
    return this.configService.create(deviceId, dto, req.user);
  }

  @Get()
  findByDevice(@Param('deviceId') deviceId: string): Promise<Configs> {
    return this.configService.findByDevice(deviceId);
  }

  @Put()
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  update(
    @Param('deviceId') deviceId: string,
    @Body() dto: UpdateDeviceConfigDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Configs> {
    return this.configService.update(deviceId, dto, req.user);
  }

  @Delete()
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  remove(
    @Param('deviceId') deviceId: string,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Configs> {
    return this.configService.remove(deviceId, req.user);
  }
}
