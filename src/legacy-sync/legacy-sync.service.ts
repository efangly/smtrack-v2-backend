import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Devices, LegacySyncMap } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { DeviceAssignmentService } from '../device/device-assignment.service';
import { DEVICE_ALL_KEY_PREFIX, deviceOneKey } from '../device/device.service';
import { AppEvents } from '../common/events/app-events';
import { buildDeviceChangedEvent, DeviceChangeAction } from '../common/events/device-changed.event';
import { buildProbeChangedEvent, ProbeChangeAction } from '../common/events/probe-changed.event';
import {
  LegacyConfigDto,
  LegacyDeletedDto,
  LegacyDeviceDeletedDto,
  LegacyDeviceDto,
  LegacyProbeDto,
  LegacyRepairDto,
  LegacyWarrantyDto,
} from './dto/legacy-snapshot.dto';
import {
  toConfigFields,
  toHardwareFields,
  toInstallPointFields,
  toProbeFields,
  toRepairFields,
  toWarrantyFields,
} from './legacy-mapper';

export type LegacyEntity = 'device' | 'probe' | 'config' | 'repair' | 'warranty';

/** applied = เขียนลง v2 แล้ว, stale = มี snapshot ใหม่กว่า apply ไปแล้ว, retired = แถวเดิมถูกแทน/ลบไปแล้ว */
export type SyncOutcome = 'applied' | 'stale' | 'retired';

/** ข้อมูลอ้างอิงที่ snapshot ชี้ถึงยังไม่มีใน v2 — throw เพื่อให้ message เข้า DLQ แล้ว replay ทีหลัง */
export class LegacyReferenceMissingError extends Error {}

const SWAP_REASON = 'legacy sync';

/**
 * Legacy sync (ADR-0007): apply snapshot จากระบบเดิมลง v2 แบบ idempotent
 *
 * - last-writer-wins ตาม `updateAt` ของระบบเดิม เก็บไว้ใน legacy_sync_map — redeliver/สลับลำดับได้ไม่พัง
 * - ไม่ต้อง lock: queue เป็น single-active-consumer + prefetch 1 (ดู buildRmqLegacySyncOptions)
 *   และ CLI backfill รันก่อนเปิด consume (ลำดับขั้นใน docs/legacy-sync-contract.md)
 * - ห้ามเขียน `Devices.serial` ตรง ๆ — เปลี่ยนกล่องต้องผ่าน DeviceAssignmentService.assign เสมอ
 */
@Injectable()
export class LegacySyncService {
  private readonly logger = new Logger(LegacySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
    private readonly assignments: DeviceAssignmentService,
  ) {}

  // ─── device (จุดติดตั้ง + กล่อง) ────────────────────────────────────────────

  async upsertDevice(d: LegacyDeviceDto): Promise<SyncOutcome> {
    const gate = await this.gate('device', d.deviceId, d.updateAt);
    if (gate.outcome) return gate.outcome;

    const serial = d.id;
    await this.prisma.hardware.upsert({
      where: { serial },
      update: toHardwareFields(d),
      create: { serial, ...toHardwareFields(d), createAt: d.createAt },
    });

    // จุดติดตั้งเดิมหาจาก map ก่อน (ทนต่อการเปลี่ยน staticName) แล้วค่อยหาจาก staticName
    // (backfill ครั้งแรก หรือแถวใหม่ของระบบเดิมที่มาแทนกล่องเสียที่จุดเดิม = Swap)
    let target: Devices | null = gate.map
      ? await this.prisma.devices.findUnique({ where: { id: gate.map.targetId } })
      : null;
    target ??= await this.prisma.devices.findUnique({ where: { staticName: d.staticName } });

    let action: DeviceChangeAction = 'updated';
    if (!target) {
      target = await this.prisma.devices.create({
        data: { ...toInstallPointFields(d), online: d.online, createAt: d.createAt },
      });
      action = 'created';
    } else {
      target = await this.prisma.devices.update({
        where: { id: target.id },
        data: toInstallPointFields(d),
      });
    }

    // แถวอื่นของระบบเดิมที่เคยชี้มาจุดนี้ = แถวของกล่องตัวเก่าก่อน Swap — ปลดออก
    // ไม่งั้น snapshot ที่มาทีหลังของแถวเก่าจะ swap กล่องเก่ากลับมา
    await this.prisma.legacySyncMap.updateMany({
      where: {
        entity: 'device',
        targetId: target.id,
        legacyId: { not: d.deviceId },
        retired: false,
      },
      data: { retired: true },
    });

    const previousSerial = target.serial;
    if (previousSerial !== serial) {
      // assign() ปิด/เปิด assignment, ล้าง cache resolve และ emit device.changed (swapped) เอง
      const { assignment } = await this.assignments.assign(target.id, serial, SWAP_REASON);
      if (action === 'created') {
        // จุดติดตั้งใหม่: วันเริ่มติดตั้งจริงมาจากระบบเดิม ไม่ใช่เวลาที่ sync
        await this.prisma.deviceAssignments.update({
          where: { id: assignment.id },
          data: { startedAt: d.installDate ?? d.createAt },
        });
      }
      this.logger.log(
        `device ${d.staticName}: ${previousSerial ?? '(empty)'} → ${serial} (${action})`,
      );
    } else {
      await this.assignments.invalidate(serial);
      this.emitDevice(action, target);
    }

    await this.invalidateDeviceCache(previousSerial, serial);
    await this.remember('device', d.deviceId, target.id, d.updateAt);
    return 'applied';
  }

  /**
   * ระบบเดิมลบแถว device = กล่องนั้นถูกถอดออกจากจุดติดตั้ง
   * v2 ไม่ลบจุดติดตั้ง (log_days อ้างถึงอยู่) แค่ปิด assignment, ล้าง serial และตั้ง status=false
   * ถ้าจุดนั้นถูก Swap เป็นกล่องอื่นไปแล้ว ไม่ต้องทำอะไรกับจุดติดตั้ง
   */
  async deleteDevice(d: LegacyDeviceDeletedDto): Promise<SyncOutcome> {
    const gate = await this.gate('device', d.deviceId, d.updateAt);
    if (gate.outcome) return gate.outcome;

    const target = gate.map
      ? await this.prisma.devices.findUnique({ where: { id: gate.map.targetId } })
      : null;

    if (target && target.serial === d.id) {
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.deviceAssignments.updateMany({
          where: { deviceId: target.id, endedAt: null },
          data: { endedAt: d.updateAt },
        });
        return tx.devices.update({
          where: { id: target.id },
          data: { serial: null, status: false },
        });
      });
      await this.assignments.invalidate(d.id);
      await this.invalidateDeviceCache(d.id);
      this.emitDevice('updated', updated);
    }

    await this.remember('device', d.deviceId, target?.id ?? '', d.updateAt, true);
    return 'applied';
  }

  // ─── probe ────────────────────────────────────────────────────────────────

  async upsertProbe(p: LegacyProbeDto): Promise<SyncOutcome> {
    const gate = await this.gate('probe', p.id, p.updateAt);
    if (gate.outcome) return gate.outcome;

    const device = await this.requireDeviceBySerial(p.sn, `probe ${p.id}`);
    const existing = gate.map
      ? await this.prisma.probes.findUnique({ where: { id: gate.map.targetId } })
      : await this.prisma.probes.findUnique({
          where: { deviceId_channel: { deviceId: device.id, channel: p.channel } },
        });

    const probe = existing
      ? await this.prisma.probes.update({
          where: { id: existing.id },
          data: { ...toProbeFields(p), deviceId: device.id },
        })
      : await this.prisma.probes.create({
          data: { ...toProbeFields(p), deviceId: device.id, createAt: p.createAt },
        });

    this.emitProbe(existing ? 'updated' : 'created', probe);
    await this.remember('probe', p.id, probe.id, p.updateAt);
    return 'applied';
  }

  /** ลบจริง — log_days.probe_id เป็น SET NULL และยังมี channel ดิบในคอลัมน์ `probe` ให้ fallback */
  async deleteProbe(d: LegacyDeletedDto): Promise<SyncOutcome> {
    const gate = await this.gate('probe', d.id, d.updateAt);
    if (gate.outcome) return gate.outcome;

    const probe = gate.map
      ? await this.prisma.probes.findUnique({ where: { id: gate.map.targetId } })
      : null;
    if (probe) {
      await this.prisma.probes.delete({ where: { id: probe.id } });
      this.emitProbe('deleted', probe);
    }
    await this.remember('probe', d.id, probe?.id ?? '', d.updateAt, true);
    return 'applied';
  }

  // ─── config ───────────────────────────────────────────────────────────────

  async upsertConfig(c: LegacyConfigDto): Promise<SyncOutcome> {
    const gate = await this.gate('config', c.id, c.updateAt);
    if (gate.outcome) return gate.outcome;

    const device = await this.requireDeviceBySerial(c.sn, `config ${c.id}`);
    const config = await this.prisma.configs.upsert({
      where: { deviceId: device.id },
      update: toConfigFields(c),
      create: { ...toConfigFields(c), deviceId: device.id, createAt: c.createAt },
    });
    await this.remember('config', c.id, config.id, c.updateAt);
    return 'applied';
  }

  async deleteConfig(d: LegacyDeletedDto): Promise<SyncOutcome> {
    return this.hardDelete('config', d, (id) => this.prisma.configs.deleteMany({ where: { id } }));
  }

  // ─── repair ───────────────────────────────────────────────────────────────

  async upsertRepair(r: LegacyRepairDto): Promise<SyncOutcome> {
    const gate = await this.gate('repair', r.id, r.updateAt);
    if (gate.outcome) return gate.outcome;

    const existing = gate.map
      ? await this.prisma.repairs.findUnique({ where: { id: gate.map.targetId } })
      : await this.prisma.repairs.findUnique({ where: { seq: r.seq } });

    const repair = existing
      ? await this.prisma.repairs.update({
          where: { id: existing.id },
          data: toRepairFields(r),
        })
      : await this.prisma.repairs.create({
          data: {
            ...toRepairFields(r),
            seq: r.seq,
            serial: await this.requireSerialByStaticName(r.devName, `repair ${r.id}`),
            createAt: r.createAt,
          },
        });

    await this.remember('repair', r.id, repair.id, r.updateAt);
    return 'applied';
  }

  async deleteRepair(d: LegacyDeletedDto): Promise<SyncOutcome> {
    return this.hardDelete('repair', d, (id) => this.prisma.repairs.deleteMany({ where: { id } }));
  }

  // ─── warranty ─────────────────────────────────────────────────────────────

  async upsertWarranty(w: LegacyWarrantyDto): Promise<SyncOutcome> {
    const gate = await this.gate('warranty', w.id, w.updateAt);
    if (gate.outcome) return gate.outcome;

    let existing = gate.map
      ? await this.prisma.warranties.findUnique({ where: { id: gate.map.targetId } })
      : null;
    let serial: string | undefined;
    if (!existing) {
      serial = await this.requireSerialByStaticName(w.devName, `warranty ${w.id}`);
      // คีย์เดียวกับที่สคริปต์ migrate รุ่นแรกใช้กันซ้ำ — แถวที่ migrate ไปก่อนมี map จะถูก claim
      existing = await this.prisma.warranties.findFirst({
        where: { serial, devName: w.devName, createAt: w.createAt },
      });
    }

    const warranty = existing
      ? await this.prisma.warranties.update({
          where: { id: existing.id },
          data: toWarrantyFields(w),
        })
      : await this.prisma.warranties.create({
          data: { ...toWarrantyFields(w), serial: serial!, createAt: w.createAt },
        });

    await this.remember('warranty', w.id, warranty.id, w.updateAt);
    return 'applied';
  }

  async deleteWarranty(d: LegacyDeletedDto): Promise<SyncOutcome> {
    return this.hardDelete('warranty', d, (id) =>
      this.prisma.warranties.deleteMany({ where: { id } }),
    );
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /** ตัดสิน LWW: คืน outcome เมื่อต้องข้าม และคืน map เดิม (ถ้ามี) เมื่อให้ apply ต่อ */
  private async gate(
    entity: LegacyEntity,
    legacyId: string,
    updateAt: Date,
  ): Promise<{ outcome?: SyncOutcome; map: LegacySyncMap | null }> {
    const map = await this.prisma.legacySyncMap.findUnique({
      where: { entity_legacyId: { entity, legacyId } },
    });
    if (map?.retired) {
      this.logger.debug(`skip ${entity} ${legacyId}: retired`);
      return { outcome: 'retired', map };
    }
    if (map && map.legacyUpdatedAt.getTime() >= updateAt.getTime()) {
      this.logger.debug(`skip ${entity} ${legacyId}: stale (${updateAt.toISOString()})`);
      return { outcome: 'stale', map };
    }
    return { map };
  }

  private async remember(
    entity: LegacyEntity,
    legacyId: string,
    targetId: string,
    legacyUpdatedAt: Date,
    retired = false,
  ): Promise<void> {
    await this.prisma.legacySyncMap.upsert({
      where: { entity_legacyId: { entity, legacyId } },
      update: { targetId, legacyUpdatedAt, retired },
      create: { entity, legacyId, targetId, legacyUpdatedAt, retired },
    });
  }

  private async hardDelete(
    entity: LegacyEntity,
    d: LegacyDeletedDto,
    remove: (targetId: string) => Promise<unknown>,
  ): Promise<SyncOutcome> {
    const gate = await this.gate(entity, d.id, d.updateAt);
    if (gate.outcome) return gate.outcome;
    if (gate.map) await remove(gate.map.targetId);
    await this.remember(entity, d.id, gate.map?.targetId ?? '', d.updateAt, true);
    return 'applied';
  }

  /** probe/config ของระบบเดิมผูกกับ serial ของกล่อง → จุดติดตั้งที่กล่องนั้นติดอยู่ตอนนี้ */
  private async requireDeviceBySerial(serial: string, what: string): Promise<Devices> {
    const device = await this.prisma.devices.findUnique({ where: { serial } });
    if (!device) {
      throw new LegacyReferenceMissingError(`${what}: no install point holds serial ${serial}`);
    }
    return device;
  }

  /** repair/warranty ของระบบเดิมผูกกับชื่อจุดติดตั้ง → serial ของกล่องที่ติดอยู่ตอนนี้ */
  private async requireSerialByStaticName(staticName: string, what: string): Promise<string> {
    const device = await this.prisma.devices.findUnique({
      where: { staticName },
      select: { serial: true },
    });
    if (!device?.serial) {
      throw new LegacyReferenceMissingError(`${what}: no box installed at ${staticName}`);
    }
    return device.serial;
  }

  private async invalidateDeviceCache(...serials: (string | null)[]): Promise<void> {
    await Promise.all(
      serials.filter((s): s is string => !!s).map((s) => this.redis.del(deviceOneKey(s))),
    );
    await this.redis.delByPattern(`${DEVICE_ALL_KEY_PREFIX}:*`);
  }

  private emitDevice(action: DeviceChangeAction, device: Devices): void {
    this.safeEmit(AppEvents.DEVICE_CHANGED, () => buildDeviceChangedEvent(action, device));
  }

  private emitProbe(
    action: ProbeChangeAction,
    probe: Parameters<typeof buildProbeChangedEvent>[1],
  ) {
    this.safeEmit(AppEvents.PROBE_CHANGED, () => buildProbeChangedEvent(action, probe));
  }

  /** listener ที่พังต้องไม่ทำให้ message ที่เขียน DB ไปแล้วถูก nack เข้า DLQ */
  private safeEmit(event: string, build: () => unknown): void {
    try {
      this.events.emit(event, build());
    } catch (err) {
      this.logger.warn(`emit ${event} ล้มเหลว: ${(err as Error).message}`);
    }
  }
}
