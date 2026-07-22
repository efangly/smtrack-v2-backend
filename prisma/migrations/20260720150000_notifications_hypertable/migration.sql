-- Convert notifications into a TimescaleDB hypertable on create_at.
-- Primary key must include the partitioning column for hypertables,
-- so we replace the single-column PK with a composite (id, create_at) PK.
-- schema.prisma keeps a single `@id` on `id` (same pattern as log_days) —
-- id stays practically unique via uuid() default, no app code changes needed.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_pkey";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id", "create_at");
SELECT create_hypertable('"notifications"', 'create_at', migrate_data => true);
