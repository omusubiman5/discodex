# Beads loopback server

The project uses the official `bd serve` HTTP API only on `127.0.0.1:17839`. It must not bind to `0.0.0.0`, a LAN address, or an externally reachable interface.

`bd serve` requires a Dolt SQL-server-backed workspace. The current embedded workspace must first complete preservation-safe migration issue `cdvb-enj.29`; attempting to start before that is expected to fail closed. After that gate, start explicitly from the repository root with:

```powershell
bd serve --addr 127.0.0.1:17839
```

Operational checks:

```powershell
Invoke-WebRequest http://127.0.0.1:17839/healthz
Invoke-WebRequest 'http://127.0.0.1:17839/v0/beads/ready?limit=1'
bd --readonly query 'parent=cdvb-enj' --all --limit 0 --json
```

The HTTP server includes write-capable routes, so it is a local control plane and is not the PM read-only display. Start and stop are explicit; background starts must record PID and stdout/stderr under ignored `runtime/beads-server/`. Stop only the recorded process. A restart must preserve the issue count and sorted ID set.

The server is a PM tracking gate, not a Discord Voice release gate. Failed health/start events create a bounded recovery issue; only a proven permission, installation, or port-ownership blocker may become a user Inbox request.

Observed 2026-08-22: the first loopback start exited with code 1 because `bd serve` does not support the embedded-Dolt backend. No listener remained and no LAN bind occurred. Recovery is tracked by ready migration issue `cdvb-enj.29` and event-derived retry `cdvb-enj.35`.
