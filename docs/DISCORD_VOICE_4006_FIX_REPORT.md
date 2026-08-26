# Discord Voice 4006 fix report

> **Document status:** Historical fix snapshot. Statements such as “not implemented” describe the state at the time of this report. See [README](../README.md) for current capabilities and platform support.

## Corrections

- `--phase live-call` now exclusively owns `runtime/live-call.lock` before credential acquisition or network activity. A second runner fails locally with `A final Discord live-call runner is already active.` Stale ownership is recovered only when the recorded PID is dead; normal completion releases the owned lock.
- The live path emits a sanitized `udp-discovered` marker at the successful discovery callback, followed by the existing DAVE/media markers.
- AES-GCM RTP-size parsing now authenticates the fixed RTP header, CSRCs, and extension preamble, while decrypting and removing RTP extension data before passing the DAVE ciphertext to native libdave.

## Changed files

- `src/discord-gateway-smoke.ts`: exclusive process lock and sanitized live stage instrumentation.
- `src/adapters/discord/rtp-aead.ts`: correct RTP-size encrypted-extension boundary.
- `tests/discord-gateway-smoke.test.ts`: overlap rejection and UDP discovery marker coverage.
- `tests/rtp-aead.test.ts`: protected RTP extension round-trip coverage.
- `docs/DISCORD_VOICE_4006_CAUSE_INVESTIGATION.md`: corrected failure-boundary analysis.
- `docs/DISCORD_VOICE_4006_FIX_REPORT.md`: reproducible correction and evidence.

## Tests

- `node --test tests/rtp-aead.test.ts tests/discord-gateway-smoke.test.ts`: 11/11 passed.
- `npm test`: 61/61 passed.
- `git diff --check`: exit 0; only pre-existing line-ending warnings were printed.

## Single-runner live verification

The authoritative runner is Node PID `21976` with the exclusive lock and UDP socket `0.0.0.0:62522`. A second live-call launch exited 1 with the local overlap error; PID `21976`, its UDP binding, and its lock remained alive. The sanitized log contains zero `4006` lines and the following observed stage counts at verification time:

```text
udp-discovered     1
ready              1
udp-received      12
dave-decrypted    12
pcm-generated     12
response-encoded  12
response-sent     12
```

A representative actual send record was:

```json
{"phase":"live-call","state":"response-sent","pcmSamples":1920,"responseOpusBytes":117,"packetBytes":161,"packets":25,"secretOutput":false,"identifierOutput":false}
```

This proves a real Discord transport regression: UDP receive, RTP AES-GCM processing, native DAVE decrypt, Opus/PCM echo generation, encode, DAVE/RTP encryption, and UDP send in one retained runner. It is **invalidated for product acceptance** because it did not bind the user's current GPT Live/Codex agent/session or preserve its context/personality/memory/skills/tools.

## Unresolved item

Status boundaries are intentionally separate:

- `internal transport regression`: **PASS and reusable**. The prior runner crossed receive, DAVE decrypt, PCM echo generation, encode/encrypt, and UDP send.
- `prior participant/counter/audibility evidence`: **invalidated for product acceptance**. An independent Bot loop is not the product.
- `same GPT Live/Codex agent/session`: **NOT IMPLEMENTED/NOT VERIFIED** at the time of this report.
- `Windows and macOS observable E2E`: **NOT VERIFIED**.

The bounded live-call timeout remains a reusable lifecycle fix. The independent echo runner has been stopped and must not be used for acceptance. The epic and `.21`–`.24` remain incomplete until same-agent binding plus real Windows and macOS bidirectional E2E; no intermediate user audibility request is authorized.
