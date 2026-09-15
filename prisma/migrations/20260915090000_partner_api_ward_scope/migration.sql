-- Partner API access model: per-serial allowlist -> per-ward (ADR-0003, supersedes the
-- allowlist-shape part of ADR-0002 — Box-serial-as-identifier reasoning in ADR-0002 itself
-- is untouched). Also backs the new gRPC ListDevicesByWard RPC.

-- DropTable
DROP TABLE "partner_api_key_devices";

-- CreateTable
CREATE TABLE "partner_api_key_wards" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "ward" TEXT NOT NULL,
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_api_key_wards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "partner_api_key_wards_key_id_ward_key" ON "partner_api_key_wards"("key_id", "ward");

CREATE INDEX "partner_api_key_wards_key_id_idx" ON "partner_api_key_wards"("key_id");

ALTER TABLE "partner_api_key_wards" ADD CONSTRAINT "partner_api_key_wards_key_id_fkey"
    FOREIGN KEY ("key_id") REFERENCES "partner_api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: audit log needs to record ward for ListDevicesByWard calls (serial stays for
-- GetDeviceSnapshot calls)
ALTER TABLE "partner_api_request_logs" ADD COLUMN "ward" TEXT;
