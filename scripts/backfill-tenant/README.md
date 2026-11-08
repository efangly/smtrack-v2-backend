# Backfill tenant (ADR-0004)

The `20261031000000_device_tenant_and_department` migration adds `devices.tenant_id` as
`NULL` and keeps the old ward allowlists of partner keys in
`partner_api_key_departments_legacy`. This script fills both from the auth-service database,
where every former ward ID is a department ID with a `tenant_id`.

```bash
AUTH_DATABASE_URL=postgresql://... npm run backfill:tenant -- --dry-run   # count only
AUTH_DATABASE_URL=postgresql://... npm run backfill:tenant                # write
```

What it does:

| Target | Change |
|---|---|
| `devices` with `tenant_id IS NULL` | set to the tenant of their `department_id` |
| `device_audit` / `user_audit` (`entity_type = 'device'`) snapshots of those devices | add `tenantId` where missing, so the read-time diff (ADR-0001) does not show a change nobody made |
| `partner_api_key_departments_legacy` | one `partner_api_key_tenants` row per key and tenant — an existing key now sees the whole tenant of each ward it had |

It is safe to re-run: it only touches devices that still have no tenant and skips partner
tenants that already exist.

Departments the auth service does not know are listed at the end and left alone — those
devices stay visible to SUPER/SERVICE only until their `departmentId` is corrected. Once the
run is clean, a follow-up migration drops `partner_api_key_departments_legacy` and the
`PartnerApiKeyDepartmentsLegacy` model.
