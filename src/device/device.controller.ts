import {
  Body,
  Controller,
  FileTypeValidator,
  Get,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { DeviceAssignments, Devices } from '../generated/prisma/client';
import { DeviceAssignmentService, SwapResult } from './device-assignment.service';
import { DeviceService } from './device.service';
import { CreateDeviceDto } from './dto/create-device.dto';
import { SwapDeviceDto } from './dto/swap-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const imageFileInterceptor = () =>
  FileInterceptor('positionPic', {
    storage: memoryStorage(),
    limits: { fileSize: MAX_IMAGE_SIZE },
  });

const uploadedImagePipe = () =>
  new ParseFilePipe({
    validators: [
      new FileTypeValidator({ fileType: /^image\/(jpe?g|png|webp)$/ }),
      new MaxFileSizeValidator({ maxSize: MAX_IMAGE_SIZE }),
    ],
    fileIsRequired: false,
  });

// หมายเหตุ: ไม่ guard controller นี้ เพื่อคงพฤติกรรมเดิมของ smtrack-log (device controller ไม่มี guard)
@ApiTags('devices')
@Controller('devices')
export class DeviceController {
  constructor(
    private readonly deviceService: DeviceService,
    private readonly assignments: DeviceAssignmentService,
  ) {}

  @Post()
  @UseInterceptors(imageFileInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        serial: { type: 'string' },
        ward: { type: 'string' },
        staticName: { type: 'string' },
        name: { type: 'string' },
        status: { type: 'boolean' },
        seq: { type: 'integer' },
        firmware: { type: 'string' },
        remark: { type: 'string' },
        position: { type: 'string' },
        location: { type: 'string' },
        tag: { type: 'string' },
        installDate: { type: 'string', format: 'date-time' },
        positionPic: { type: 'string', format: 'binary' },
      },
    },
  })
  create(
    @Body() dto: CreateDeviceDto,
    @UploadedFile(uploadedImagePipe()) file?: Express.Multer.File,
  ): Promise<Devices> {
    return this.deviceService.create(dto, file);
  }

  @Get()
  findAll(): Promise<Devices[]> {
    return this.deviceService.findAll();
  }

  @Get(':serial')
  findOne(@Param('serial') serial: string): Promise<Devices> {
    return this.deviceService.findOne(serial);
  }

  /** หาจุดติดตั้งด้วย identity ถาวร — ใช้ได้แม้ตอนนั้นยังไม่มีกล่องติดตั้งอยู่ */
  @Get('by-name/:staticName')
  findByStaticName(@Param('staticName') staticName: string): Promise<Devices> {
    return this.deviceService.findByStaticName(staticName);
  }

  /**
   * สลับกล่องฮาร์ดแวร์ของจุดติดตั้งนี้ (เครื่องพัง → เอาเครื่องใหม่มาแทน)
   *
   * config/probe และประวัติ telemetry ของจุดติดตั้งยังอยู่ครบเพราะผูกกับ Devices.id ไม่ใช่ serial
   * และ log เก่าของกล่องเดิมยังเป็นของจุดนี้ เพราะถูกประทับ device_id ไว้ตั้งแต่ตอน ingest
   */
  @Post('by-name/:staticName/swap')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER, Role.SERVICE, Role.ADMIN)
  swap(@Param('staticName') staticName: string, @Body() dto: SwapDeviceDto): Promise<SwapResult> {
    return this.assignments.swapByStaticName(staticName, dto.serial, dto.reason);
  }

  /** ประวัติการติดตั้งของจุดติดตั้ง — กล่องไหนอยู่ช่วงเวลาใด */
  @Get('by-name/:staticName/assignments')
  @ApiBearerAuth('jwt')
  @UseGuards(JwtAuthGuard)
  async assignmentHistory(@Param('staticName') staticName: string): Promise<DeviceAssignments[]> {
    const device = await this.deviceService.findByStaticName(staticName);
    return this.assignments.history(device.id);
  }

  @Put(':id')
  @UseInterceptors(imageFileInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        ward: { type: 'string' },
        staticName: { type: 'string' },
        name: { type: 'string' },
        status: { type: 'boolean' },
        seq: { type: 'integer' },
        firmware: { type: 'string' },
        remark: { type: 'string' },
        position: { type: 'string' },
        location: { type: 'string' },
        tag: { type: 'string' },
        installDate: { type: 'string', format: 'date-time' },
        positionPic: { type: 'string', format: 'binary' },
      },
    },
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDeviceDto,
    @UploadedFile(uploadedImagePipe()) file?: Express.Multer.File,
  ): Promise<Devices> {
    return this.deviceService.update(id, dto, file);
  }
}
