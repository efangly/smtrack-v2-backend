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
import { DeviceAssignmentService } from '../device/device-assignment.service';

// ทุก route ต้อง login และตรวจว่าจุดติดตั้งอยู่ใน scope (tenant/department) ของผู้ใช้ — ตรวจที่ controller
// เพราะ DeviceConfigService ถูกใช้ซ้ำจาก /adjust ที่ตั้งใจไม่ login
// create/update/delete จำกัด role เพิ่ม (SUPER/SERVICE/ADMIN) เพราะกระทบ network setting ของอุปกรณ์โดยตรง
@ApiTags('device-config')
@Controller('devices/:deviceId/config')
export class DeviceConfigController {
  constructor(
    private readonly configService: DeviceConfigService,
    private readonly assignments: DeviceAssignmentService,
  ) {}

  @Post()
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  async create(
    @Param('deviceId') deviceId: string,
    @Body() dto: CreateDeviceConfigDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Configs> {
    await this.assignments.assertDeviceAccess(req.user.scope, deviceId);
    return this.configService.create(deviceId, dto, req.user);
  }

  @Get()
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard)
  async findByDevice(
    @Param('deviceId') deviceId: string,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Configs> {
    await this.assignments.assertDeviceAccess(req.user.scope, deviceId);
    return this.configService.findByDevice(deviceId);
  }

  @Put()
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  async update(
    @Param('deviceId') deviceId: string,
    @Body() dto: UpdateDeviceConfigDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Configs> {
    await this.assignments.assertDeviceAccess(req.user.scope, deviceId);
    return this.configService.update(deviceId, dto, req.user);
  }

  @Delete()
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  async remove(
    @Param('deviceId') deviceId: string,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Configs> {
    await this.assignments.assertDeviceAccess(req.user.scope, deviceId);
    return this.configService.remove(deviceId, req.user);
  }
}
