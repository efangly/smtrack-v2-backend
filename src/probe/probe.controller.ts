import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Probes } from '../generated/prisma/client';
import { ProbeService, ProbeTelemetrySnapshot } from './probe.service';
import { CreateProbeDto } from './dto/create-probe.dto';
import { UpdateProbeDto } from './dto/update-probe.dto';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { AccessScope } from '../common/auth/access-scope';
import { DeviceAssignmentService } from '../device/device-assignment.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';

// ทุก route ต้อง login และตรวจว่าจุดติดตั้งของ probe อยู่ใน scope (tenant/department) ของผู้ใช้ — ตรวจที่
// controller เพราะ ProbeService ถูกใช้ซ้ำจาก /adjust ที่ตั้งใจไม่ login
// create/update/delete จำกัด role เพิ่ม (SUPER/SERVICE/ADMIN) เพราะกระทบ threshold ของอุปกรณ์โดยตรง
@ApiTags('probes')
@Controller()
export class ProbeController {
  constructor(
    private readonly probeService: ProbeService,
    private readonly assignments: DeviceAssignmentService,
  ) {}

  /** probe นอก scope ตอบ 404 เหมือนจุดติดตั้ง */
  private async findAccessibleProbe(id: string, scope: AccessScope): Promise<Probes> {
    const probe = await this.probeService.findOne(id);
    await this.assignments.assertDeviceAccess(scope, probe.deviceId);
    return probe;
  }

  @Post('devices/:deviceId/probes')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  async create(
    @Param('deviceId') deviceId: string,
    @Body() dto: CreateProbeDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Probes> {
    await this.assignments.assertDeviceAccess(req.user.scope, deviceId);
    return this.probeService.create(deviceId, dto, req.user);
  }

  @Get('devices/:deviceId/probes')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard)
  async findAllByDevice(
    @Param('deviceId') deviceId: string,
    @Query() pagination: PaginationQueryDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Paginated<Probes>> {
    await this.assignments.assertDeviceAccess(req.user.scope, deviceId);
    return this.probeService.findAllByDevice(deviceId, pagination);
  }

  @Get('devices/:deviceId/probes/telemetry')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard)
  async findLatestTelemetryByDevice(
    @Param('deviceId') deviceId: string,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<ProbeTelemetrySnapshot[]> {
    await this.assignments.assertDeviceAccess(req.user.scope, deviceId);
    return this.probeService.findLatestTelemetryByDevice(deviceId);
  }

  @Get('probes/:id')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard)
  findOne(@Param('id') id: string, @Req() req: Request & { user: JwtPayloadDto }): Promise<Probes> {
    return this.findAccessibleProbe(id, req.user.scope);
  }

  @Put('probes/:id')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProbeDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Probes> {
    await this.findAccessibleProbe(id, req.user.scope);
    return this.probeService.update(id, dto, req.user);
  }

  @Delete('probes/:id')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  async remove(
    @Param('id') id: string,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Probes> {
    await this.findAccessibleProbe(id, req.user.scope);
    return this.probeService.remove(id, req.user);
  }
}
