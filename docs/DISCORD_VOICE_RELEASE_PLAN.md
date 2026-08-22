# Discord Voice shortest release path

Beads epic `cdvb-enj` is canonical; this document is a user-readable projection, not a parallel task ledger. Every execution bead is bounded to ten minutes and contains its own verification command and blocker.

1. Official cryptographic bridge
   - `cdvb-enj.31`: official C API conformance — closed, 9/9.
   - `cdvb-enj.32`: thin Node native link/load/session feasibility — closed.
   - `cdvb-enj.10`: production binding contract.
2. Safe local configuration and Gateway
   - `cdvb-enj.14`: local credential-provider boundary — ready; secret values must never enter conversation or logs.
   - `cdvb-enj.15`–`.18`: external application/server/install/token-store gates, kept separate.
   - `cdvb-enj.19`: timed Gateway Ready, dependent on those gates.
3. Real Voice prerequisites
   - `cdvb-enj.20`: UDP discovery.
   - `cdvb-enj.21`: official DAVE transition.
   - `cdvb-enj.22` and `.23`: bounded encrypted send and decrypted receive.
   - `cdvb-enj.24`: PCM route to the Codex adapter boundary.
4. Tracking and audit
   - `cdvb-enj.29`: ready preservation-safe migration needed for the loopback PM server.
   - `cdvb-enj.35`: event-derived server recovery, blocked by `.29`.
   - `cdvb-enj.33`: ready independent audit gate.

The Beads HTTP server is not on the Discord Voice release dependency chain. A server outage is tracked and recovered without idling C API, Node, configuration, Gateway, or audio work.
