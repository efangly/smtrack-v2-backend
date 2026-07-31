import {
  Body,
  Controller,
  Delete,
  Get,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import { Firmwares } from '../generated/prisma/client';
import { FirmwareService } from './firmware.service';
import { CreateFirmwareDto } from './dto/create-firmware.dto';
import { UpdateFirmwareDto } from './dto/update-firmware.dto';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';
import { SkipInterceptor } from '../common/decorators/skip-interceptor.decorator';

// ต้องเป็นค่าคงที่ระดับโมดูล (ไม่ใช่ DI/ConfigService) เพราะ FileInterceptor decorator ถูก evaluate
// ตอน class ถูกประกาศ (ก่อน Nest DI พร้อม) — เหมือน MAX_IMAGE_SIZE ใน device.controller.ts
const MAX_FIRMWARE_SIZE = parseInt(
  process.env.FIRMWARE_MAX_FILE_SIZE ?? `${100 * 1024 * 1024}`,
  10,
);

const firmwareFileInterceptor = () =>
  FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_FIRMWARE_SIZE } });

const uploadedFirmwarePipe = (required: boolean) =>
  new ParseFilePipe({
    validators: [new MaxFileSizeValidator({ maxSize: MAX_FIRMWARE_SIZE })],
    fileIsRequired: required,
  });

// หมายเหตุ: การจัดการรายการ (สร้าง/แก้ไข/ลบ/list/detail) เป็นงานแอดมิน guard ด้วย JwtAuthGuard
// + RolesGuard เหมือน warranties/device-repair — ส่วน /latest และ /download/:version เปิด public
// ไม่ guard เพราะเป็น endpoint ที่อุปกรณ์ IoT เรียกโดยตรงตอนเช็ค/โหลด OTA (ยังไม่มี device-token
// flow สำหรับ use case นี้)
@ApiTags('firmware')
@Controller('firmware')
export class FirmwareController {
  constructor(private readonly firmwareService: FirmwareService) {}

  @Post()
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  @UseInterceptors(firmwareFileInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        version: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  create(
    @Body() dto: CreateFirmwareDto,
    @Req() req: Request & { user: JwtPayloadDto },
    @UploadedFile(uploadedFirmwarePipe(true)) file: Express.Multer.File,
  ): Promise<Firmwares> {
    return this.firmwareService.create(dto, file, req.user);
  }

  @Get()
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  findAll(@Query() pagination: PaginationQueryDto): Promise<Paginated<Firmwares>> {
    return this.firmwareService.findAll(pagination);
  }

  /** ให้อุปกรณ์เช็คเวอร์ชั่นล่าสุดก่อนตัดสินใจดาวน์โหลด — public, ไม่ guard */
  @Get('latest')
  findLatest(): Promise<Firmwares> {
    return this.firmwareService.findLatest();
  }

  @Get(':id')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  findOne(@Param('id') id: string): Promise<Firmwares> {
    return this.firmwareService.findOne(id);
  }

  /** อุปกรณ์ IoT ดาวน์โหลดไฟล์ firmware ตรงจากที่นี่ — public, ไม่ guard, ไม่ห่อ response ผ่าน ResponseInterceptor */
  @Get('download/:version')
  @SkipInterceptor()
  async download(@Param('version') version: string, @Res() res: Response): Promise<void> {
    const firmware = await this.firmwareService.findByVersion(version);
    const stream = await this.firmwareService.getStream(firmware);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${firmware.fileName}"`);
    stream.pipe(res);
  }

  @Put(':id')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  @UseInterceptors(firmwareFileInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateFirmwareDto,
    @Req() req: Request & { user: JwtPayloadDto },
    @UploadedFile(uploadedFirmwarePipe(false)) file?: Express.Multer.File,
  ): Promise<Firmwares> {
    return this.firmwareService.update(id, dto, file, req.user);
  }

  @Delete(':id')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  remove(
    @Param('id') id: string,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<Firmwares> {
    return this.firmwareService.remove(id, req.user);
  }
}
