# SMtrack v2 Backend

IoT telemetry/log ingestion, real-time push, and notification system for medical device monitoring (see project README/CLAUDE.md for the full architecture).

## Language

**Audit diff**:
The set of fields that changed between one `DeviceAudit` snapshot and the immediately preceding snapshot for the same device, shown as `{ field: { from, to } }`. Computed on read, not stored — see [ADR-0001](./docs/adr/0001-compute-device-audit-diff-at-read-time.md).
_Avoid_: change log, delta (when referring to this specific computed value)

**Install point**:
A logical, permanently-named location a monitoring box lives at (e.g. "ICU bed 3 fridge") — the `Devices` row, identified by `staticName`. Distinct from the physical box installed there.
_Avoid_: device (ambiguous with the physical box), location

**Box / Hardware**:
The physical device that reports telemetry via MQTT/JWT, identified by `serial`. Can be swapped between install points; its own history (firmware, repairs, warranty) follows the box, not the install point.
_Avoid_: device (ambiguous with the install point), unit

**Swap**:
Replacing the box currently occupying an install point with a different one, recorded as a new `DeviceAssignments` row with a closed predecessor. The only path allowed to change `Devices.serial`.
_Avoid_: move device, reassign (when referring specifically to a serial change — "move" is ambiguous between this and changing `ward`/`position`)
