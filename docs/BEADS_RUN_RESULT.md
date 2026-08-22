# Beads run result

Run date: 2026-08-22

Scope: canonical epic reconciliation, atomic release-path issues, and loopback-only HTTP server recovery. Discord credentials and external network connection are excluded.

Baseline:

- Database: `.beads\embeddeddolt`, prefix `cdvb`, schema 1.
- Existing count before new canonical children: 53.
- Canonical epic: `cdvb-enj`; 29 existing children were retained.
- Added children: `cdvb-enj.30` goal document, `cdvb-enj.31` C API, `cdvb-enj.32` Node native feasibility, and `cdvb-enj.33` independent audit.

Execution:

- Requested bind: `127.0.0.1:17839`; the port was free before start.
- Command: `bd serve --addr 127.0.0.1:17839` via a hidden, PID-captured `Start-Process`.
- Actual event: `health_failed`. The process exited 1 before listening because `bd serve` requires a Dolt SQL server and the project uses the embedded-Dolt backend.
- Recovery action: verified that no listener or residual `bd` process remained; preserved the database; activated ready migration prerequisite `cdvb-enj.29`; created event-derived retry `cdvb-enj.35`.
- No LAN bind, credential access, Discord connection, destructive reinitialization, or user Inbox escalation occurred.
- `bd --readonly query 'parent=cdvb-enj' --all --limit 0 --json` succeeded with 35 canonical children.
- Final database count after the result/recovery issues: 59.
- Sorted full ID-set SHA-256: `89B048CD2BD2AAB6DEA61EE32DC7558854C39C5D79CBD8781B0BB5BC1D72D310`.

Restart integrity is not claimed: the same-setting restart cannot reach health until the preservation-safe embedded-to-server migration completes. This is tracked, rather than treated as a Discord Voice release blocker. Independent audit is ready as `cdvb-enj.33`.
