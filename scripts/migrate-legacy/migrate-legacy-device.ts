import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Day } from '../../src/generated/prisma/client';

/**
 * One-shot cutover: copies metadata from the legacy smtrack-device DB (SOURCE_DATABASE_URL)
 * into this project's schema (DATABASE_URL). Does NOT touch LogDays/notifications — see
 * scripts/migrate-legacy/README.md. Not idempotent: run once against an empty target.
 */

interface LegacyDevice {
  deviceId: string;
  id: string; // real serial number — every legacy FK ("sn", LogDays.serial) points here, not deviceId
  staticName: string;
  ward: string;
  name: string | null;
  status: boolean;
  seq: number;
  location: string | null;
  position: string | null;
  positionPic: string | null;
  installDate: Date | null;
  firmware: string;
  remark: string | null;
  online: boolean;
  tag: string | null;
  token: string | null;
  createAt: Date;
  updateAt: Date;
}

interface LegacyProbe {
  id: string;
  sn: string;
  name: string | null;
  type: string | null;
  channel: string;
  tempMin: number;
  tempMax: number;
  humiMin: number;
  humiMax: number;
  tempAdj: number;
  humiAdj: number;
  stampTime: string | null;
  doorQty: number;
  position: string | null;
  muteAlarmDuration: string | null;
  doorSound: boolean;
  doorAlarmTime: string | null;
  muteDoorAlarmDuration: string | null;
  notiDelay: number;
  notiToNormal: boolean;
  notiMobile: boolean;
  notiRepeat: number;
  firstDay: Day;
  secondDay: Day;
  thirdDay: Day;
  firstTime: string | null;
  secondTime: string | null;
  thirdTime: string | null;
  createAt: Date;
  updateAt: Date;
}

interface LegacyConfig {
  id: string;
  sn: string;
  dhcp: boolean;
  ip: string | null;
  mac: string | null;
  subnet: string | null;
  gateway: string | null;
  dns: string | null;
  dhcpEth: boolean | null;
  ipEth: string | null;
  macEth: string | null;
  subnetEth: string | null;
  gatewayEth: string | null;
  dnsEth: string | null;
  ssid: string | null;
  password: string | null;
  simSP: string | null;
  email1: string | null;
  email2: string | null;
  email3: string | null;
  hardReset: string | null;
  createAt: Date;
  updateAt: Date;
}

interface LegacyRepair {
  id: string;
  seq: number;
  devName: string;
  info: string | null;
  info1: string | null;
  info2: string | null;
  address: string | null;
  ward: string | null;
  detail: string | null;
  phone: string | null;
  status: string | null;
  warrantyStatus: string | null;
  remark: string | null;
  createAt: Date;
  updateAt: Date;
}

interface LegacyWarranty {
  id: string;
  devName: string;
  product: string | null;
  model: string | null;
  installDate: string | null;
  customerName: string | null;
  customerAddress: string | null;
  saleDepartment: string | null;
  invoice: string | null;
  expire: Date;
  status: boolean;
  note: string | null;
  createAt: Date;
  updateAt: Date;
}

interface Summary {
  created: number;
  skipped: number;
}

function newSummary(): Summary {
  return { created: 0, skipped: 0 };
}

async function migrateDevices(
  source: Pool,
  target: PrismaClient,
): Promise<{
  summary: Summary;
  serialToNewDeviceId: Map<string, string>;
  staticNameToSerial: Map<string, string>;
}> {
  const summary = newSummary();
  const serialToNewDeviceId = new Map<string, string>();
  const staticNameToSerial = new Map<string, string>();

  const { rows } = await source.query<LegacyDevice>('SELECT * FROM "Devices"');

  for (const legacy of rows) {
    await target.hardware.upsert({
      where: { serial: legacy.id },
      update: {},
      create: {
        serial: legacy.id,
        firmware: legacy.firmware,
        token: legacy.token,
        installDate: legacy.installDate,
        createAt: legacy.createAt,
        updateAt: legacy.updateAt,
      },
    });

    const device = await target.devices.create({
      data: {
        staticName: legacy.staticName,
        serial: legacy.id,
        ward: legacy.ward,
        name: legacy.name,
        status: legacy.status,
        seq: legacy.seq,
        location: legacy.location,
        position: legacy.position,
        positionPic: legacy.positionPic,
        remark: legacy.remark,
        online: legacy.online,
        tag: legacy.tag,
        createAt: legacy.createAt,
        updateAt: legacy.updateAt,
      },
    });

    await target.deviceAssignments.create({
      data: {
        deviceId: device.id,
        serial: legacy.id,
        startedAt: legacy.installDate ?? legacy.createAt,
        endedAt: null,
        reason: 'migrated from legacy system',
      },
    });

    serialToNewDeviceId.set(legacy.id, device.id);
    staticNameToSerial.set(legacy.staticName, legacy.id);
    summary.created += 1;
  }

  return { summary, serialToNewDeviceId, staticNameToSerial };
}

async function migrateProbes(
  source: Pool,
  target: PrismaClient,
  serialToNewDeviceId: Map<string, string>,
): Promise<Summary> {
  const summary = newSummary();
  const { rows } = await source.query<LegacyProbe>('SELECT * FROM "Probes"');

  for (const legacy of rows) {
    const deviceId = serialToNewDeviceId.get(legacy.sn);
    if (!deviceId) {
      console.warn(`[probes] skip ${legacy.id}: no device for sn=${legacy.sn}`);
      summary.skipped += 1;
      continue;
    }
    await target.probes.create({
      data: {
        deviceId,
        name: legacy.name,
        type: legacy.type,
        channel: legacy.channel,
        tempMin: legacy.tempMin,
        tempMax: legacy.tempMax,
        humiMin: legacy.humiMin,
        humiMax: legacy.humiMax,
        tempAdj: legacy.tempAdj,
        humiAdj: legacy.humiAdj,
        stampTime: legacy.stampTime,
        doorQty: legacy.doorQty,
        position: legacy.position,
        muteAlarmDuration: legacy.muteAlarmDuration,
        doorSound: legacy.doorSound,
        doorAlarmTime: legacy.doorAlarmTime,
        muteDoorAlarmDuration: legacy.muteDoorAlarmDuration,
        notiDelay: legacy.notiDelay,
        notiToNormal: legacy.notiToNormal,
        notiMobile: legacy.notiMobile,
        notiRepeat: legacy.notiRepeat,
        firstDay: legacy.firstDay,
        secondDay: legacy.secondDay,
        thirdDay: legacy.thirdDay,
        firstTime: legacy.firstTime,
        secondTime: legacy.secondTime,
        thirdTime: legacy.thirdTime,
        createAt: legacy.createAt,
        updateAt: legacy.updateAt,
      },
    });
    summary.created += 1;
  }

  return summary;
}

async function migrateConfigs(
  source: Pool,
  target: PrismaClient,
  serialToNewDeviceId: Map<string, string>,
): Promise<Summary> {
  const summary = newSummary();
  const { rows } = await source.query<LegacyConfig>('SELECT * FROM "Configs"');

  for (const legacy of rows) {
    const deviceId = serialToNewDeviceId.get(legacy.sn);
    if (!deviceId) {
      console.warn(`[configs] skip ${legacy.id}: no device for sn=${legacy.sn}`);
      summary.skipped += 1;
      continue;
    }
    await target.configs.create({
      data: {
        deviceId,
        dhcp: legacy.dhcp,
        ip: legacy.ip,
        mac: legacy.mac,
        subnet: legacy.subnet,
        gateway: legacy.gateway,
        dns: legacy.dns,
        dhcpEth: legacy.dhcpEth,
        ipEth: legacy.ipEth,
        macEth: legacy.macEth,
        subnetEth: legacy.subnetEth,
        gatewayEth: legacy.gatewayEth,
        dnsEth: legacy.dnsEth,
        ssid: legacy.ssid,
        password: legacy.password,
        simSP: legacy.simSP,
        email1: legacy.email1,
        email2: legacy.email2,
        email3: legacy.email3,
        hardReset: legacy.hardReset,
        createAt: legacy.createAt,
        updateAt: legacy.updateAt,
      },
    });
    summary.created += 1;
  }

  return summary;
}

async function migrateRepairs(
  source: Pool,
  target: PrismaClient,
  staticNameToSerial: Map<string, string>,
): Promise<Summary> {
  const summary = newSummary();
  const { rows } = await source.query<LegacyRepair>('SELECT * FROM "Repairs"');

  for (const legacy of rows) {
    const serial = staticNameToSerial.get(legacy.devName);
    if (!serial) {
      console.warn(`[repairs] skip ${legacy.id}: no device for devName=${legacy.devName}`);
      summary.skipped += 1;
      continue;
    }
    await target.repairs.create({
      data: {
        seq: legacy.seq,
        serial,
        devName: legacy.devName,
        info: legacy.info,
        info1: legacy.info1,
        info2: legacy.info2,
        address: legacy.address,
        ward: legacy.ward,
        detail: legacy.detail,
        phone: legacy.phone,
        status: legacy.status,
        warrantyStatus: legacy.warrantyStatus,
        remark: legacy.remark,
        createAt: legacy.createAt,
        updateAt: legacy.updateAt,
      },
    });
    summary.created += 1;
  }

  return summary;
}

async function migrateWarranties(
  source: Pool,
  target: PrismaClient,
  staticNameToSerial: Map<string, string>,
): Promise<Summary> {
  const summary = newSummary();
  const { rows } = await source.query<LegacyWarranty>('SELECT * FROM "Warranties"');

  for (const legacy of rows) {
    const serial = staticNameToSerial.get(legacy.devName);
    if (!serial) {
      console.warn(`[warranties] skip ${legacy.id}: no device for devName=${legacy.devName}`);
      summary.skipped += 1;
      continue;
    }
    await target.warranties.create({
      data: {
        serial,
        devName: legacy.devName,
        product: legacy.product,
        model: legacy.model,
        installDate: legacy.installDate,
        customerName: legacy.customerName,
        customerAddress: legacy.customerAddress,
        saleDepartment: legacy.saleDepartment,
        invoice: legacy.invoice,
        expire: legacy.expire,
        status: legacy.status,
        note: legacy.note,
        createAt: legacy.createAt,
        updateAt: legacy.updateAt,
      },
    });
    summary.created += 1;
  }

  return summary;
}

async function main(): Promise<void> {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  if (!sourceUrl) throw new Error('SOURCE_DATABASE_URL is required (legacy smtrack-device DB)');

  const source = new Pool({ connectionString: sourceUrl });
  const target = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

  try {
    console.log('migrating Devices → Hardware + Devices + DeviceAssignments ...');
    const { summary: devicesSummary, serialToNewDeviceId, staticNameToSerial } =
      await migrateDevices(source, target);
    console.log(`  devices: created=${devicesSummary.created}`);

    console.log('migrating Probes ...');
    const probesSummary = await migrateProbes(source, target, serialToNewDeviceId);
    console.log(`  probes: created=${probesSummary.created} skipped=${probesSummary.skipped}`);

    console.log('migrating Configs ...');
    const configsSummary = await migrateConfigs(source, target, serialToNewDeviceId);
    console.log(`  configs: created=${configsSummary.created} skipped=${configsSummary.skipped}`);

    console.log('migrating Repairs ...');
    const repairsSummary = await migrateRepairs(source, target, staticNameToSerial);
    console.log(`  repairs: created=${repairsSummary.created} skipped=${repairsSummary.skipped}`);

    console.log('migrating Warranties ...');
    const warrantiesSummary = await migrateWarranties(source, target, staticNameToSerial);
    console.log(
      `  warranties: created=${warrantiesSummary.created} skipped=${warrantiesSummary.skipped}`,
    );

    console.log('migration done.');
  } finally {
    await target.$disconnect();
    await source.end();
  }
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
