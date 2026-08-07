import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Warranties } from '../generated/prisma/client';
import { WarrantiesService } from './warranties.service';
import { CreateWarrantyDto } from './dto/create-warranty.dto';
import { UpdateWarrantyDto } from './dto/update-warranty.dto';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { QueryWarrantyDto } from './dto/query-warranty.dto';
import { Paginated } from '../common/pagination/paginated.dto';

// หมายเหตุ: ข้อมูลประกัน (ชื่อ/ที่อยู่ลูกค้า) เป็นข้อมูลแอดมินภายใน ไม่ใช่ dashboard สาธารณะ
// จึง guard ทุก route รวมถึง GET ด้วย RolesGuard เหมือน device-repair (ต่างจาก device/probe/config)
@ApiTags('warranties')
@Controller('warranties')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
export class WarrantiesController {
  constructor(private readonly warrantiesService: WarrantiesService) {}

  @Post()
  create(
    @Body() dto: CreateWarrantyDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Warranties> {
    return this.warrantiesService.create(dto, req.user);
  }

  @Get()
  findAll(@Query() query: QueryWarrantyDto): Promise<Paginated<Warranties>> {
    return this.warrantiesService.findAll(query);
  }

  @Get('by-serial/:serial')
  findBySerial(@Param('serial') serial: string): Promise<Warranties[]> {
    return this.warrantiesService.findBySerial(serial);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<Warranties> {
    return this.warrantiesService.findOne(id);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWarrantyDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Warranties> {
    return this.warrantiesService.update(id, dto, req.user);
  }
}
