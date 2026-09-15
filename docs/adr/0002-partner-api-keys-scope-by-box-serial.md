# Partner API keys scope by Box serial, not Install Point

The new Partner API (third-party read access to device metadata + time series) needs a stable identifier to key its endpoints and per-key allowlists on. The glossary distinguishes **Install point** (`staticName`, stable across hardware swaps) from **Box** (`serial`, follows the physical unit and changes on a [[Swap]]) — Install point is the "obviously correct" choice for anything meant to stay stable.

We chose **Box `serial`** anyway. Partners manage their own record of which `serial` maps to which physical asset on their side, and are expected to update their own records when a swap happens — the swap-safety Install point exists to provide is explicitly not wanted here; partner integrations track the physical box, not the location.

**Consequence**: a Partner API key's device allowlist is a list of serials. If hardware is swapped at an install point, the key does *not* follow the swap — the partner must be notified out-of-band and update their own configuration. This is a deliberate trade-off, not an oversight; do not "fix" it by switching the allowlist to `staticName`/install point without re-confirming this is still what partners want.
