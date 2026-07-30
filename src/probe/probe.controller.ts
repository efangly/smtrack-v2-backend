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
import { ProbeService } from './probe.service';
import { CreateProbeDto } from './dto/create-probe.dto';
import { UpdateProbeDto } from './dto/update-probe.dto';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';

// หมายเหตุ: GET routes ไม่ guard เพื่อคงพฤติกรรมเดิมเหมือน device.controller.ts
// ส่วน create/update/delete guard ด้วย JwtAuthGuard + RolesGuard (SUPER/SERVICE/ADMIN)
// เหมือน device-repair เพราะกระทบ threshold/network setting ของอุปกรณ์โดยตรง
@ApiTags('probes')
@Controller()
export class ProbeController {
  constructor(private readonly probeService: ProbeService) {}

  @Post('devices/:deviceId/probes')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  create(
    @Param('deviceId') deviceId: string,
    @Body() dto: CreateProbeDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Probes> {
    return this.probeService.create(deviceId, dto, req.user);
  }

  @Get('devices/:deviceId/probes')
  findAllByDevice(
    @Param('deviceId') deviceId: string,
    @Query() pagination: PaginationQueryDto,
  ): Promise<Paginated<Probes>> {
    return this.probeService.findAllByDevice(deviceId, pagination);
  }

  @Get('probes/:id')
  findOne(@Param('id') id: string): Promise<Probes> {
    return this.probeService.findOne(id);
  }

  @Put('probes/:id')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProbeDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Probes> {
    return this.probeService.update(id, dto, req.user);
  }

  @Delete('probes/:id')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  remove(@Param('id') id: string, @Req() req: Request & { user: JwtPayloadDto }): Promise<Probes> {
    return this.probeService.remove(id, req.user);
  }
}
