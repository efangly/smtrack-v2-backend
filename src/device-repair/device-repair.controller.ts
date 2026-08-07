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
import { Repairs } from '../generated/prisma/client';
import { DeviceRepairService } from './device-repair.service';
import { CreateRepairDto } from './dto/create-repair.dto';
import { UpdateRepairDto } from './dto/update-repair.dto';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';

// หมายเหตุ: ประวัติซ่อม (เบอร์โทร/ที่อยู่/สถานะ) เป็นข้อมูลแอดมินภายใน ไม่ใช่ dashboard สาธารณะ
// จึง guard ทุก route รวมถึง GET ด้วย RolesGuard ต่างจาก device/probe/config ที่ GET ไม่ guard
@ApiTags('device-repair')
@Controller('repairs')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
export class DeviceRepairController {
  constructor(private readonly repairService: DeviceRepairService) {}

  @Post()
  create(
    @Body() dto: CreateRepairDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Repairs> {
    return this.repairService.create(dto, req.user);
  }

  @Get()
  findAll(@Query() pagination: PaginationQueryDto): Promise<Paginated<Repairs>> {
    return this.repairService.findAll(pagination);
  }

  @Get('by-serial/:serial')
  findBySerial(@Param('serial') serial: string): Promise<Repairs[]> {
    return this.repairService.findBySerial(serial);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<Repairs> {
    return this.repairService.findOne(id);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRepairDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Repairs> {
    return this.repairService.update(id, dto, req.user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: Request & { user: JwtPayloadDto }): Promise<Repairs> {
    return this.repairService.remove(id, req.user);
  }
}
