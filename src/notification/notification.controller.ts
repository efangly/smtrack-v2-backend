import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Notifications } from '../generated/prisma/client';
import { NotificationService } from './notification.service';
import { CreateNotificationDto } from './dto/create-notification.dto';

@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Post()
  create(@Body() dto: CreateNotificationDto): Promise<Notifications> {
    return this.notificationService.create(dto);
  }

  @Get(':serial')
  findBySerial(@Param('serial') serial: string): Promise<Notifications[]> {
    return this.notificationService.findBySerial(serial);
  }
}
