import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { MobileService } from './mobile.service';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { JwtPayloadDto } from '../common/dto/payload.dto';

@ApiTags('mobile')
@ApiBearerAuth('jwt')
@Controller('mobile')
@UseGuards(JwtAuthGuard)
export class MobileController {
  constructor(private readonly mobileService: MobileService) {}

  @Get()
  findNotification(@Req() req: Request & { user: JwtPayloadDto }) {
    return this.mobileService.findNotification(req.user);
  }

  @Get(':ward')
  findWard(@Param('ward') ward: string) {
    return this.mobileService.findWard(ward);
  }
}
