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
import { Notifications } from '../generated/prisma/client';
import { NotificationService, NotificationDashboardCount } from './notification.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { DeviceJwtAuthGuard } from '../common/guards/device.guard';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { DevicePayloadDto } from '../common/dto/device-payload.dto';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { NotificationQueryDto } from './dto/query-notification.dto';
import { Paginated } from '../common/pagination/paginated.dto';

@ApiTags('notifications')
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Post()
  @UseGuards(DeviceJwtAuthGuard)
  @ApiBearerAuth('device')
  create(
    @Body() dto: CreateNotificationDto,
    @Req() req: Request & { user: DevicePayloadDto },
  ): Promise<Notifications> {
    dto.serial = req.user.sn;
    return this.notificationService.create(dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  findAll(
    @Query() query: NotificationQueryDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Paginated<Notifications>> {
    return this.notificationService.findAll(query, req.user);
  }

  // ต้องมาก่อน :serial ไม่งั้น 'dashboard' จะถูกจับเป็นค่า serial
  @Get('dashboard/count')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  findDashboardCount(
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<NotificationDashboardCount> {
    return this.notificationService.findCount(req.user);
  }

  @Get(':serial')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  findBySerial(@Param('serial') serial: string): Promise<Notifications[]> {
    return this.notificationService.findBySerial(serial);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth('jwt')
  @Roles(Role.SUPER, Role.SERVICE)
  update(@Param('id') id: string, @Body() dto: UpdateNotificationDto): Promise<Notifications> {
    return this.notificationService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth('jwt')
  @Roles(Role.SUPER, Role.SERVICE)
  remove(@Param('id') id: string): Promise<Notifications> {
    return this.notificationService.remove(id);
  }
}
