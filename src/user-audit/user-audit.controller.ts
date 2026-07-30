import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserAudit } from '../generated/prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { UserAuditService } from './user-audit.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';

@ApiTags('users')
@Controller('users')
export class UserAuditController {
  constructor(private readonly userAuditService: UserAuditService) {}

  /** ประวัติ action ของ user คนหนึ่งข้าม entity (device/probe/config/repair) เรียงจากใหม่ไปเก่า */
  @Get(':actorId/audit')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  findByActor(
    @Param('actorId') actorId: string,
    @Query() pagination: PaginationQueryDto,
  ): Promise<Paginated<UserAudit>> {
    return this.userAuditService.findByActor(actorId, pagination);
  }
}
