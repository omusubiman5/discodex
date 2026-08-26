# Official libdave native addon loader result

Evidence ID: `native-addon-loader-pass`

The tracked Node boundary now loads only a `.node` addon, requires a positive maximum DAVE protocol version, executes the credential-free native session lifecycle probe, and fails closed if the surface is malformed, returns false, or throws. It returns only provider, transport, version, and lifecycle status; it exposes no key material.

Verification:

- `node --test tests/native-addon.test.ts`: deterministic valid/invalid loader cases pass.
- `node work/node-native-binding-probe/load-probe.cjs`: the built addon linked to official libdave reports `maxProtocolVersion: 1` and `sessionLifecycle: true`.
- `npm test`: full project regression gate.

Boundary: this proves the tracked Node load/probe seam. Production MLS message and Opus buffer marshalling, Discord credentials, Gateway/UDP connection, and real audio remain separate gates.
