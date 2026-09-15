import { Controller, Delete, Get, Param, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CreatedPartnerApiKey,
  PartnerApiKeyService,
  PartnerApiKeySummary,
} from './partner-api-key.service';
import { CreatePartnerApiKeyDto } from './dto/create-partner-api-key.dto';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';

// เฉพาะ Role.SUPER — ออก key ให้ third-party เป็นการให้สิทธิ์เข้าถึงข้อมูล จึงไม่เปิดให้ ADMIN
// ทั่วไปตาม grill session Q13
@ApiTags('partner')
@ApiBearerAuth('jwt')
@Controller('admin/partner-keys')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER)
export class AdminPartnerKeyController {
  constructor(private readonly partnerApiKeyService: PartnerApiKeyService) {}

  @Post()
  create(@Body() dto: CreatePartnerApiKeyDto): Promise<CreatedPartnerApiKey> {
    return this.partnerApiKeyService.create(dto);
  }

  @Get()
  findAll(@Query() query: PaginationQueryDto): Promise<Paginated<PartnerApiKeySummary>> {
    return this.partnerApiKeyService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<PartnerApiKeySummary> {
    return this.partnerApiKeyService.findOne(id);
  }

  @Delete(':id')
  revoke(@Param('id') id: string): Promise<PartnerApiKeySummary> {
    return this.partnerApiKeyService.revoke(id);
  }
}
