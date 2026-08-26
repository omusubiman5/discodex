# Discord Voice 4006 cause investigation

## Reproduction

1. Start `node src/discord-gateway-smoke.ts --phase live-call` for the configured private target.
2. While it is still connected, start the same phase from a second executor.
3. Without process ownership, both processes request a voice state for the same bot identity and create competing Voice Gateway sessions.
4. Discord invalidates the superseded session with close code `4006`.

The reproduced host contained two concurrent `live-call` process trees. Identity and endpoint checks confirmed that they were competing instances of this product path, not unrelated Node services.

## Sanitized observations

The old shared log contained these lines:

```json
{"phase":"live-call","state":"ready","botParticipant":true,"daveActive":true,"secretOutput":false,"identifierOutput":false}
{"phase":"live-call","state":"error","message":"Discord Voice Gateway closed before UDP discovery (code 4006).","secretOutput":false,"identifierOutput":false}
```

Those lines came from overlapping runners and cannot be treated as one runner's ordered trace. The old close message was also generic: the close handler always said `before UDP discovery`, regardless of the actual phase reached by that particular runner. Therefore the defensible first failure boundary is: the superseded runner received Voice close `4006` before it produced its own sanitized acceptance stages. It is not valid to infer that the same runner first completed DAVE readiness and then failed before UDP discovery.

## Root cause

The `live-call` CLI had no cross-process ownership. Concurrent acceptance orchestration could replace the bot's authoritative Discord voice session, after which Discord closed the superseded session as no longer valid (`4006`). This is an orchestration race, not evidence of a libdave failure.

After the ownership fix, a separate real-media defect became observable: RTP-size packets with header extensions were treated as if all extension bytes were unencrypted AAD. Discord RTP-size framing leaves only the extension preamble unencrypted; extension data is encrypted with the media payload. That mismatch caused authenticated RTP to reach `udp-received` but fail before `dave-decrypted`. It was not the cause of `4006`, but it blocked the required end-to-end acceptance after `4006` was removed.

## Current live boundary

The corrected single runner produced `udp-discovered`, `ready`, `udp-received`, `dave-decrypted`, `pcm-generated`, `response-encoded`, and `response-sent`, with zero `4006` lines. No credential, Discord identifier, key material, MLS payload, prompt, or audio bytes were recorded. These records are **invalidated for product acceptance**: the response used an independent 20 ms PCM echo adapter, not the same GPT Live/Codex agent/session.

The previous runner later stopped because the live phase used a fixed ten-minute timeout; its final timeout line was not a new `4006`. The wait is now explicitly bounded up to 24 hours. Internal transport regression is PASS and reusable. Bot presence, counters, zero `4006`, and independent-bot audibility cannot satisfy the corrected product requirement. Same-agent/session binding and Windows/macOS observable E2E remain NOT VERIFIED; product acceptance is NOT MET.
