import { Prisma } from '../generated/prisma/client';
import {
  LegacyConfigDto,
  LegacyDeviceDto,
  LegacyProbeDto,
  LegacyRepairDto,
  LegacyWarrantyDto,
} from './dto/legacy-snapshot.dto';

/**
 * Anti-corruption layer ของ legacy sync (ADR-0007): แปลงแถวของระบบเดิม → field ของ v2
 * เป็น pure function ล้วน ใช้ร่วมกันทั้ง consumer (live) และ CLI backfill
 *
 * ระบบเดิมเก็บ "กล่อง" กับ "จุดติดตั้ง" ไว้ในแถวเดียวกัน (`Devices`) แต่ v2 แยกเป็น
 * Hardware (serial) + Devices (staticName) + DeviceAssignments — ดู scripts/migrate-legacy/README.md
 */

/** field ของจุดติดตั้งที่ระบบเดิมเป็นเจ้าของ — `online` ไม่อยู่ในนี้ เพราะ event device-online/offline เป็นเจ้าของ */
export function toInstallPointFields(d: LegacyDeviceDto) {
  return {
    staticName: d.staticName,
    // hospital/ward ของระบบเดิมคือ id ของ tenant/department ใน auth service (ADR-0004)
    tenantId: d.hospital,
    departmentId: d.ward,
    name: d.name ?? null,
    status: d.status,
    seq: d.seq,
    location: d.location ?? null,
    position: d.position ?? null,
    positionPic: d.positionPic ?? null,
    remark: d.remark ?? null,
    tag: d.tag ?? null,
  } satisfies Prisma.DevicesUncheckedUpdateInput;
}

export function toHardwareFields(d: LegacyDeviceDto) {
  return {
    firmware: d.firmware,
    token: d.token ?? null,
    installDate: d.installDate ?? null,
  } satisfies Prisma.HardwareUncheckedUpdateInput;
}

export function toProbeFields(p: LegacyProbeDto) {
  return {
    name: p.name ?? null,
    type: p.type ?? null,
    channel: p.channel,
    tempMin: p.tempMin,
    tempMax: p.tempMax,
    humiMin: p.humiMin,
    humiMax: p.humiMax,
    tempAdj: p.tempAdj,
    humiAdj: p.humiAdj,
    stampTime: p.stampTime ?? null,
    doorQty: p.doorQty,
    position: p.position ?? null,
    muteAlarmDuration: p.muteAlarmDuration ?? null,
    doorSound: p.doorSound,
    doorAlarmTime: p.doorAlarmTime ?? null,
    muteDoorAlarmDuration: p.muteDoorAlarmDuration ?? null,
    notiDelay: p.notiDelay,
    notiToNormal: p.notiToNormal,
    notiMobile: p.notiMobile,
    notiRepeat: p.notiRepeat,
    firstDay: p.firstDay,
    secondDay: p.secondDay,
    thirdDay: p.thirdDay,
    firstTime: p.firstTime ?? null,
    secondTime: p.secondTime ?? null,
    thirdTime: p.thirdTime ?? null,
  } satisfies Prisma.ProbesUncheckedUpdateInput;
}

export function toConfigFields(c: LegacyConfigDto) {
  return {
    dhcp: c.dhcp,
    ip: c.ip ?? null,
    mac: c.mac ?? null,
    subnet: c.subnet ?? null,
    gateway: c.gateway ?? null,
    dns: c.dns ?? null,
    dhcpEth: c.dhcpEth ?? null,
    ipEth: c.ipEth ?? null,
    macEth: c.macEth ?? null,
    subnetEth: c.subnetEth ?? null,
    gatewayEth: c.gatewayEth ?? null,
    dnsEth: c.dnsEth ?? null,
    ssid: c.ssid ?? null,
    password: c.password ?? null,
    simSP: c.simSP ?? null,
    email1: c.email1 ?? null,
    email2: c.email2 ?? null,
    email3: c.email3 ?? null,
    hardReset: c.hardReset ?? null,
  } satisfies Prisma.ConfigsUncheckedUpdateInput;
}

/** ไม่มี `serial` — serial ถูกกำหนดครั้งเดียวตอนสร้าง (ประวัติซ่อมติดไปกับกล่อง ไม่ย้ายตาม Swap) */
export function toRepairFields(r: LegacyRepairDto) {
  return {
    devName: r.devName,
    info: r.info ?? null,
    info1: r.info1 ?? null,
    info2: r.info2 ?? null,
    address: r.address ?? null,
    ward: r.ward ?? null,
    detail: r.detail ?? null,
    phone: r.phone ?? null,
    status: r.status ?? null,
    warrantyStatus: r.warrantyStatus ?? null,
    remark: r.remark ?? null,
  } satisfies Prisma.RepairsUncheckedUpdateInput;
}

/** ไม่มี `serial` ด้วยเหตุผลเดียวกับ repair */
export function toWarrantyFields(w: LegacyWarrantyDto) {
  return {
    devName: w.devName,
    product: w.product ?? null,
    model: w.model ?? null,
    installDate: w.installDate ?? null,
    customerName: w.customerName ?? null,
    customerAddress: w.customerAddress ?? null,
    saleDepartment: w.saleDepartment ?? null,
    invoice: w.invoice ?? null,
    expire: w.expire,
    status: w.status,
    note: w.note ?? null,
  } satisfies Prisma.WarrantiesUncheckedUpdateInput;
}
