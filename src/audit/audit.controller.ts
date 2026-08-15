import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DeviceService } from '../device/device.service';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { AuditService, DeviceAuditEntry } from './audit.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';

@ApiTags('devices')
@Controller('devices')
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    private readonly deviceService: DeviceService,
  ) {}

  /** ประวัติการเพิ่ม/แก้ไข/สลับข้อมูลของจุดติดตั้ง เรียงจากใหม่ไปเก่า */
  @Get('by-name/:staticName/audit')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  async findByDevice(
    @Param('staticName') staticName: string,
    @Query() pagination: PaginationQueryDto,
  ): Promise<Paginated<DeviceAuditEntry>> {
    const device = await this.deviceService.findByStaticName(staticName);
    return this.auditService.findByDevice(device.id, pagination);
  }
}
