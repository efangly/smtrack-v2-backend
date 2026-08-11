import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repairs } from '../generated/prisma/client';
import { AppEvents } from '../common/events/app-events';
import { RepairChangeAction, buildRepairChangedEvent } from '../common/events/repair-changed.event';
import { DeviceChangeActor } from '../common/events/device-changed.event';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRepairDto } from './dto/create-repair.dto';
import { UpdateRepairDto } from './dto/update-repair.dto';
import { QueryRepairDto } from './dto/query-repair.dto';
import { Paginated } from '../common/pagination/paginated.dto';
import { paginationSkip, toPaginated } from '../common/pagination/paginate.util';

@Injectable()
export class DeviceRepairService {
  private readonly logger = new Logger(DeviceRepairService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  private emitChanged(
    action: RepairChangeAction,
    repair: Repairs,
    actor?: DeviceChangeActor,
  ): void {
    try {
      this.events.emit(AppEvents.REPAIR_CHANGED, buildRepairChangedEvent(action, repair, actor));
    } catch (err) {
      this.logger.warn(`emit repair.changed (${action}) ล้มเหลว: ${(err as Error).message}`);
    }
  }

  async create(dto: CreateRepairDto, actor?: DeviceChangeActor): Promise<Repairs> {
    const repair = await this.prisma.repairs.create({ data: dto });
    this.emitChanged('created', repair, actor);
    return repair;
  }

  async findAll(query: QueryRepairDto): Promise<Paginated<Repairs>> {
    const where = query.status ? { status: query.status } : undefined;
    const [data, total] = await Promise.all([
      this.prisma.repairs.findMany({
        where,
        orderBy: { createAt: 'desc' },
        skip: paginationSkip(query),
        take: query.limit ?? 20,
      }),
      this.prisma.repairs.count({ where }),
    ]);
    return toPaginated(data, total, query);
  }

  findBySerial(serial: string): Promise<Repairs[]> {
    return this.prisma.repairs.findMany({ where: { serial }, orderBy: { createAt: 'desc' } });
  }

  async findOne(id: string): Promise<Repairs> {
    const repair = await this.prisma.repairs.findUnique({ where: { id } });
    if (!repair) {
      throw new NotFoundException(`Repair ${id} not found`);
    }
    return repair;
  }

  // serial ผูกกับกล่องตั้งแต่สร้าง ไม่ให้แก้ย้อนหลัง (เปลี่ยนกล่องต้องสร้างรายการซ่อมใหม่)
  async update(id: string, dto: UpdateRepairDto, actor?: DeviceChangeActor): Promise<Repairs> {
    const { serial: _unusedSerial, ...fields } = dto;
    void _unusedSerial;
    const repair = await this.prisma.repairs.update({ where: { id }, data: fields });
    this.emitChanged('updated', repair, actor);
    return repair;
  }

  async remove(id: string, actor?: DeviceChangeActor): Promise<Repairs> {
    await this.findOne(id);
    const repair = await this.prisma.repairs.delete({ where: { id } });
    this.emitChanged('deleted', repair, actor);
    return repair;
  }
}
