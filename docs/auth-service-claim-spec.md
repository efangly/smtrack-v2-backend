# Requested access-token claim: `departmentScope`

For the auth-service team. Context: [ADR-0004](adr/0004-device-tenant-scope.md).

An ordinary user (USER, LEGACY_USER, GUEST) may see **every** department of their tenant or
**only some**. Today the access token carries `tenantId` and `departmentIds`, which cannot tell
"all departments, including ones created later" apart from "these departments".

## Claim

| Claim | Type | Meaning |
|---|---|---|
| `departmentScope` | `"ALL"` \| `"SELECTED"` | `ALL`: every department of `tenantId`, now and later. `SELECTED`: only `departmentIds`. |

- Needed for USER, LEGACY_USER and GUEST. ADMIN/LEGACY_ADMIN are always treated as `ALL`, and
  SUPER/SERVICE as every tenant, whatever the claim says.
- `departmentIds` stays as it is. With `SELECTED` an empty list means "sees nothing".
- Like every claim, it must be rebuilt from the database on refresh, not copied from the old
  token.

## Backend behaviour

- Claim missing (today): ordinary users are treated as `SELECTED`.
- `"ALL"`: tenant-wide. Any other value, `"SELECTED"` included, falls back to `departmentIds`.
- A token whose role needs a tenant but has no `tenantId` is rejected with 401.

All of this lives in `scopeFromClaims` (`src/common/auth/access-scope.ts`). When the payload
changes, that function and `JwtStrategy` are the only places to update.
