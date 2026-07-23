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
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { Devices } from '../generated/prisma/client';
import { DeviceService } from './device.service';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';

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
  constructor(private readonly deviceService: DeviceService) {}

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
