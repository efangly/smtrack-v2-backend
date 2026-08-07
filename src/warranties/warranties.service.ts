import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Warranties } from '../generated/prisma/client';
import { AppEvents } from '../common/events/app-events';
import {
  WarrantyChangeAction,
  buildWarrantyChangedEvent,
} from '../common/events/warranty-changed.event';
import { DeviceChangeActor } from '../common/events/device-changed.event';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWarrantyDto } from './dto/create-warranty.dto';
import { UpdateWarrantyDto } from './dto/update-warranty.dto';
import { QueryWarrantyDto } from './dto/query-warranty.dto';
import { Paginated } from '../common/pagination/paginated.dto';
import { paginationSkip, toPaginated } from '../common/pagination/paginate.util';

@Injectable()
export class WarrantiesService {
  private readonly logger = new Logger(WarrantiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  private emitChanged(
    action: WarrantyChangeAction,
    warranty: Warranties,
    actor?: DeviceChangeActor,
  ): void {
    try {
      this.events.emit(
        AppEvents.WARRANTY_CHANGED,
        buildWarrantyChangedEvent(action, warranty, actor),
      );
    } catch (err) {
      this.logger.warn(`emit warranty.changed (${action}) ล้มเหลว: ${(err as Error).message}`);
    }
  }

  async create(dto: CreateWarrantyDto, actor?: DeviceChangeActor): Promise<Warranties> {
    const warranty = await this.prisma.warranties.create({ data: dto });
    this.emitChanged('created', warranty, actor);
    return warranty;
  }

  async findAll(query: QueryWarrantyDto): Promise<Paginated<Warranties>> {
    const searchCondition = query.search
      ? {
          OR: [
            { devName: { contains: query.search, mode: 'insensitive' as const } },
            { customerName: { contains: query.search, mode: 'insensitive' as const } },
            { product: { contains: query.search, mode: 'insensitive' as const } },
            { model: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : undefined;
    const expiringSoonCondition = query.expiringSoon
      ? {
          status: true,
          expire: { gte: new Date(), lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
        }
      : undefined;
    const where =
      searchCondition || expiringSoonCondition
        ? { ...searchCondition, ...expiringSoonCondition }
        : undefined;

    const [data, total] = await Promise.all([
      this.prisma.warranties.findMany({
        where,
        orderBy: { createAt: 'desc' },
        skip: paginationSkip(query),
        take: query.limit ?? 20,
      }),
      this.prisma.warranties.count({ where }),
    ]);
    return toPaginated(data, total, query);
  }

  findBySerial(serial: string): Promise<Warranties[]> {
    return this.prisma.warranties.findMany({ where: { serial }, orderBy: { createAt: 'desc' } });
  }

  async findOne(id: string): Promise<Warranties> {
    const warranty = await this.prisma.warranties.findUnique({ where: { id } });
    if (!warranty) {
      throw new NotFoundException(`Warranty ${id} not found`);
    }
    return warranty;
  }

  // serial ผูกกับกล่องตั้งแต่สร้าง ไม่ให้แก้ย้อนหลัง (เปลี่ยนกล่องต้องสร้างรายการประกันใหม่)
  async update(id: string, dto: UpdateWarrantyDto, actor?: DeviceChangeActor): Promise<Warranties> {
    const { serial: _unusedSerial, ...fields } = dto;
    void _unusedSerial;
    const warranty = await this.prisma.warranties.update({ where: { id }, data: fields });
    this.emitChanged('updated', warranty, actor);
    return warranty;
  }
}
