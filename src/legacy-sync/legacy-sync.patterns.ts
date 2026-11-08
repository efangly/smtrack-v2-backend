/**
 * message pattern ที่ระบบเดิม publish เข้า exchange `legacy.sync` (ADR-0007)
 * ใช้เป็นทั้ง `pattern` ใน envelope ของ Nest และ routing key — สัญญาเต็มอยู่ใน docs/legacy-sync-contract.md
 */
export const LegacySyncPatterns = {
  DEVICE_UPSERTED: 'legacy.device.upserted',
  DEVICE_DELETED: 'legacy.device.deleted',
  PROBE_UPSERTED: 'legacy.probe.upserted',
  PROBE_DELETED: 'legacy.probe.deleted',
  CONFIG_UPSERTED: 'legacy.config.upserted',
  CONFIG_DELETED: 'legacy.config.deleted',
  REPAIR_UPSERTED: 'legacy.repair.upserted',
  REPAIR_DELETED: 'legacy.repair.deleted',
  WARRANTY_UPSERTED: 'legacy.warranty.upserted',
  WARRANTY_DELETED: 'legacy.warranty.deleted',
} as const;
