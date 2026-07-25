import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { LogDays } from '../generated/prisma/client';
import { TelemetryService } from '../telemetry/telemetry.service';
import { CreateTelemetryDto } from '../telemetry/dto/create-telemetry.dto';
import { LogdayService } from './logday.service';
import { UpdateLogdayDto } from './dto/update-logday.dto';
import { DeviceJwtAuthGuard } from '../common/guards/device.guard';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { DevicePayloadDto } from '../common/dto/device-payload.dto';
import { DeviceAssignmentService } from '../device/device-assignment.service';

@ApiTags('logday')
@Controller('logday')
export class LogdayController {
  constructor(
    private readonly logdayService: LogdayService,
    private readonly telemetryService: TelemetryService,
    private readonly assignments: DeviceAssignmentService,
  ) {}

  /** รับได้ทั้ง serial ของกล่องที่ติดตั้งอยู่ และ staticName ของจุดติดตั้ง (ดู GraphController) */
  @Get(':serialOrName')
  async summary(@Param('serialOrName') serialOrName: string) {
    const deviceId = await this.assignments.resolveDeviceIdOrThrow(serialOrName);
    return this.logdayService.summaryByDevice(deviceId);
  }

  /**
   * HTTP ingest สำหรับอุปกรณ์ที่ยิงตรงผ่าน REST — คู่ขนานกับ MQTT (MqttController)
   * และ RabbitMQ (LogConsumerController) เรียก TelemetryService.ingest() ตัวเดียวกันทั้ง 3 ทาง ไม่มี insert logic ซ้ำ
   */
  @Post()
  @UseGuards(DeviceJwtAuthGuard)
  @ApiBearerAuth('device')
  @HttpCode(201)
  async create(
    @Body() body: CreateTelemetryDto | CreateTelemetryDto[],
    @Req() req: Request & { user: DevicePayloadDto },
  ): Promise<LogDays | LogDays[]> {
    const entries = Array.isArray(body) ? body : [body];
    const results: LogDays[] = [];
    for (const entry of entries) {
      entry.serial = req.user.sn;
      results.push(await this.telemetryService.ingest(entry));
    }
    return Array.isArray(body) ? results : results[0];
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth('jwt')
  @Roles(Role.SUPER, Role.SERVICE)
  update(@Param('id') id: string, @Body() dto: UpdateLogdayDto): Promise<LogDays> {
    return this.logdayService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth('jwt')
  @Roles(Role.SUPER, Role.SERVICE)
  remove(@Param('id') id: string): Promise<LogDays> {
    return this.logdayService.remove(id);
  }
}
