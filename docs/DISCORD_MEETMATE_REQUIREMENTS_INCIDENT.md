# Discord Meetmate requirements incident

> **Document status:** Historical incident record. It is retained for traceability and is not the current product-status document. See [README](../README.md) for current capabilities and platform support.

## Incident boundary

On 2026-08-23, approximately 00:12–15:xx JST, the project treated an independent Discord bot audio loop as product acceptance. That completion claim is withdrawn. The transport evidence remains useful only as a regression baseline and is **invalidated for product acceptance**.

## Root cause

MeetMateのDiscord版という製品目的をcanonical acceptanceへ固定せず、同一GPT Live/Codex agent binding、Windows/macOS両対応を欠いたままproxyを完了扱いした管理・要件トレーサビリティ不良。

The implementation optimized the first measurable Discord/DAVE path without maintaining a bidirectional trace from the external product reference through Epic, Issue, test, and observable evidence. `BoundedCodexPcmAdapter` was a 20 ms sample echo, not a Codex gateway; it had no thread/session identity, existing context, personality, memory, skills, tools, voice-brain loop, or macOS path.

## Canonical external references

- https://github.com/caty-ai/meetmate
- https://github.com/caty-ai/meetmate/blob/main/docs/TECHNICAL.md
- https://github.com/caty-ai/meetmate/blob/main/docs/architecture.md
- https://github.com/caty-ai/meetmate/blob/main/docs/setup-guide.md
- https://github.com/caty-ai/meetmate/blob/main/docs/deploy-checklist.md

Meetmate's default gateway mode is the product analogy: the participant is the existing agent with native personality, memory, skills, tools, and history. A separate plain OpenAI-compatible model is degraded and does not satisfy this product.

## Impact inventory

| Area | Impact and correction |
|---|---|
| Code | Discord Gateway/Voice v8, DAVE, RTP AEAD, Opus and single-runner exclusion are reusable transport. `BoundedCodexPcmAdapter` and its live-call default are not an agent integration and must be replaced. |
| Acceptance evidence | Tone and injected-frame proxies are invalidated for product acceptance; real end-to-end evidence remains required. |
| Docs | 4006 reports conflated internal transport PASS and product acceptance; they now separate these boundaries. |
| Tests | DAVE/RTP/Opus tests remain transport regressions. New negative traceability tests reject proxy-only and unit-only OS evidence. |
| Artifacts | Prior logs, counters, PIDs and Bot presence are retained sanitized and invalidated for product acceptance. They prove no agent identity or conversation continuity. |
| User requests | Speech/audibility requests during the incident window were premature and are withdrawn. No user action is requested until same-agent binding and both-OS internal E2E exist. |

## Code-level gap matrix

| Capability | Current fact | Disposition | Issue |
|---|---|---|---|
| Discord Gateway/Voice join | implemented on Windows | reuse: transport regression | `.21` |
| DAVE control/media crypto | official libdave path implemented | reuse: transport regression | `.21` |
| RTP AEAD and UDP | implemented | reuse: transport regression | `.22`, `.23` |
| Opus encode/decode | ffmpeg adapter on Windows | reuse contract; cross-platform setup required | `.22`–`.24` |
| 4006 single-runner exclusion | implemented | reuse: lifecycle regression | `.21` |
| Same GPT Live/Codex gateway | no production binding | missing | `.21` |
| Same thread/session identity/context | current thread identity exists in host environment; runtime handoff absent | missing | `.21` |
| Personality/memory/skills/tools | not proven; echo cannot provide it | missing | `.21`, `.24` |
| Discord input → voice brain | decoded PCM enters echo | replace | `.23`, `.24` |
| Voice brain → Discord output | echo PCM enters send path | replace | `.22`, `.24` |
| STT/TTS or equivalent realtime audio | absent | missing | `.24` |
| Barge-in/stop/reconnect | agent output cancellation/session reconnect absent | missing | `.21`, `.24` |
| Windows real E2E | transport-only evidence | missing | `.21`–`.24` |
| macOS adapters/setup/credentials/real E2E | absent | missing | `.21`–`.24` |

## Preventive control

`src/core/product-acceptance.ts` pins the primary references and fails closed unless every requirement links a stable requirement reference, evidence ID, source path, and named test. Proxy evidence is always rejected; Windows/macOS gates accept only their respective real-E2E evidence. `tests/product-acceptance.test.ts` proves independent-bot proxy evidence and unit-only OS evidence cannot close the product.

## Current status

Internal Discord/DAVE transport regression: **PASS and reusable**. Product acceptance: **NOT MET**. Completion is prohibited until the current Codex thread/session owns the audio conversation and real bidirectional E2E passes on Windows and macOS.
