# Beads Operations

Use this reference after resolving the canonical product ledger and selecting
one role. It defines execution control, not product requirements.

## Source and Handoff Boundary

1. Before acceptance, requests, notes, and Markdown goals remain in the existing
   intake process. They may describe the artifact and completion conditions but
   are not execution status.
2. Acceptance creates or reuses one canonical Beads epic and records its ID and
   link at the intake source.
3. From acceptance onward, the mapped canonical product ledger exclusively owns
   child identity, dependencies, status, assignee/claim, evidence, and one
   concrete blocker with its smallest resume condition.
4. The old Markdown or HTML entry retains only the epic link and `transferred`.
   Do not copy cards, counts, detailed status, evidence, or blockers back to it.
5. Preserve existing active work. Confirm its mapping and epic, add the thin
   link, stop dual writes, and migrate in stages without deleting, merging, or
   rewriting a working ledger.

An explicit status-source guide, parent goal, or equivalent mapping wins. When
none exists, use the project-local ledger. A server-onboarding ledger may own
runtime readiness but never product progress. PMO reads both ledgers read-only
and judges progress only from the mapped product ledger.

## Accepted Artifact Delivery Loop

Follow this chain without inserting a shadow tracker:

`intake -> artifact and completion conditions -> canonical epic -> duplicate
check -> missing atomic product issues -> necessary dependencies -> ready ->
claim -> implement -> verify -> reproducible evidence comment -> close -> next
ready`

The planner expands only product work missing from the accepted epic. Compare
`project + normalized objective + deliverable + source reference`; reuse exact
matches and stop for review on similar candidates. Each execution issue should
be a small product increment that can be implemented, verified, and evidenced
in one run.

For user-facing PC, UI, or device work, the planner includes the dependency
chain `implementation -> real-environment observable acceptance -> rollback
readiness -> independent product confirmation`. The independent confirmation is
after product implementation and acceptance, never an audit that blocks them
from starting.

The executor repeatedly runs `bd ready`, inspects and claims one existing issue,
changes the real artifact, runs its acceptance check, comments concise
reproducible evidence, closes only on PASS, reads the result back, and takes the
next ready issue. Continue until artifact completion or one true blocker.

### Audit-improvement dispatch

When an independent verifier reports FAIL, a route-specific No-Go, an
unimplemented requirement, or missing evidence, PMO or the planner accepts the
finding keyed to its canonical epic and issue ID. In the same review cycle it
reads the existing issue, dependencies, and numbered next/remediation issue,
then dispatches that existing ready issue to its executor. It does not create a
duplicate, merely record or forward the report, or leave a stale `in_progress`
issue. If the current or remediation issue cannot run, record on that same issue
one exact external blocker and the minimum resume condition. PMO never performs
the remediation or its independent verification, and the verifier never audits
its own implementation.

Cleanup follows integration and functional verification. Independent checking
follows implementation evidence; it never replaces implementation.

## Observable Product Acceptance

Define every deliverable in one sentence as an outcome a user can observe. At
least one acceptance criterion names who performs the check, the real
environment, the operation, and what becomes visible or functional. A file or
registry hash, unit test, mock, generated event, or other internal proxy may
support that criterion but cannot complete the product by itself.

### Fail-closed product close preflight

Before `bd close` on a product Issue or Epic, run:

`node .agents/skills/beads/scripts/quick_validate.js --repo . --epic <canonical-epic-id>`

The command reads the canonical ledger with `bd --readonly list --all --json`;
it never writes Beads. The Epic owns `metadata.product_acceptance` with an
external HTTPS `product_url`, a concrete `voice_agent_identity`, a nonempty
`supported_os` array, and a `requirements` map containing these close gates:
`external_product_url`, `voice_agent_identity`, `supported_os`, and
`observable_real_e2e`. Each gate points to one descendant product Issue and
names its `test_ref` and `evidence_ref`. That Issue points back through
`metadata.acceptance_trace.epic_id` and repeats the same gate, test, and
evidence references. Missing or mismatched links fail closed.

The observable E2E trace additionally records
`evidence_kind=observable_real_e2e`, the actor, real environment, operation,
and observable result. A process/PID, participant presence, count/counter, unit
test, mock, or internal transport event may be linked as supporting evidence,
but none may occupy the observable E2E gate or authorize product close.

The concrete recurrence example is the canonical Discord incident
`bead:cdvb-enj` and its live voice acceptance chain. Read that ledger for
current state; this rulebook deliberately does not copy its status or evidence.

For PC, UI, and device artifacts, a shadow Codex separate from the implementer
uses the real screen or device and records the observable result. Do not close
from implementer self-report or internal state alone. Preserve valid technical
evidence when the external check fails, but narrow its claim and keep product
completion open.

### Planner pre-create lint

Before creating or assigning an issue, reject it when any of these are true:

- the owner is generically `human` or `user` although a concrete executor,
  shadow, or verifier role can perform the work;
- acceptance merely says the user reviews, configures, confirms, or operates,
  without naming a visible E2E outcome;
- a human blocker has no recorded failed command/path, external refusal, or
  other evidence that an authorized agent route is impossible;
- a product epic is blocked as a whole while independent implementation, test,
  preparation, or evidence work remains ready.

Assign each atomic product issue to its concrete agent role. A human issue is
allowed only for a measured human-presence requirement, identity-bound secret,
MFA/biometric/security key, physical lock removal, or irreversible value
decision. It contains one minimal action, an exact resume condition, and a
downstream agent issue that automatically resumes immediately afterward.

## Role Boundaries

- **User / artifact owner:** defines the artifact, completion conditions, major
  decisions, and actions only that person can perform. Does not decompose work.
- **PMO:** resolves the explicit mapping; queries canonical product and separate
  onboarding Dolt ledgers strictly read-only; extracts epic, children,
  dependencies, status, assignee, latest heartbeat or final evidence, ready,
  in-progress, blocked, and one resume condition. It compares independent
  current facts before declaring an issue stale. Only after proving a stop does
  it request one resume from the same assignee on the same issue in that review
  cycle. It does not plan, decompose, implement, test, write evidence, audit, or
  send no-change updates. In each bounded monitoring slice, it extracts
  human-owned and human-blocked issues, independently checks whether a shadow
  route exists, and reassigns the same issue to that agent role when possible;
  PMO never performs the work. A closed issue without observable evidence is
  not a completed user-facing product; PMO records the canonical/external
  mismatch.
- **Planner:** starts from an accepted epic, performs duplicate search, and adds
  only missing atomic product issues and required dependencies, including real
  environment acceptance, rollback readiness, and final independent checking
  for user-facing work. It does not add operational placeholders, duplicate
  work, or an audit before the artifact.
- **Executor:** owns `ready -> claim -> implement -> verify -> evidence -> close
  -> next ready` continuously. Before declaring a human gate, it checks allowed
  PC automation paths and tries safe reversible actions. It stops only at
  completion or a true blocker.
- **Independent verifier:** spot-checks current commands, files, tests, OS/device
  state, external services, and Beads readback. It does not accept self-report
  as proof and deepens inspection only when a spot-check disagrees. For UI and
  device acceptance, it must be a different Codex from the implementer.
- **Beads / Dolt operator:** maintains the mapped ledger's epic/child identity,
  dependencies, status, claims, and evidence, with start/end readback. Separate
  onboarding ledgers remain separate.

## Views, Existing Tools, and Secrets

Beads Board is a projection of the selected workspace. `bd graph --html` is the
official epic/dependency view. Prefer maintained official or established OSS
viewers and their configuration before creating anything. A custom HTML page,
if retained, is only a thin portfolio link to canonical Board/Graph views; it is
not a cross-project status ledger.

Do not display credentials, tokens, private authentication data, or secret-bearing
comments. Keep server and viewer listeners on numeric loopback unless the user
explicitly authorizes a different boundary.

## Blocking and Token Discipline

Do not classify a tap or physical-looking step as a human gate by name alone.
The executor first checks permitted browser/computer automation, ADB, device
management, or equivalent PC paths read-only, then tries safe reversible actions
within existing authority. Return to the user only after those paths prove a
human-presence requirement by refusal or impossibility, or for identity-bound
MFA/biometrics/security keys and irreversible decisions.

Never broaden permissions or safety boundaries, and do not probe an irreversible
change, external publication, or credential exposure. A failed automation path
records its concise command, current external state, and refusal result on the
same issue, then reduces the stop to one blocker and the smallest resume
condition. Do not block on "seems impossible," create a replacement issue, or
repeatedly page. Continue every independent ready issue.

Report only an artifact change, externally verified PASS, or a true blocker.
Avoid no-change updates, long hash inventories, PMO full-regression repetition,
and per-issue startup reports. Evidence must still identify the command or fact
needed to reproduce acceptance.

### Live network configuration approval exception

A change to a live network device is a stronger owner-approval gate than an
ordinary shadow-assisted PC operation. Read-only evidence collection, design,
dry-run validation, rollback preparation, and verifier preparation remain
agent-owned and proceed first. Immediately before apply, present the exact
device, scope, diff, expected interruption, rollback, and verifier to the
artifact owner. Apply requires fresh, explicit approval for that exact change;
shadow agents, executors, and PMO cannot approve it, and neither broad nor old
approval may be reused.

PMO strictly read-only verifies the owner-approval evidence in the canonical
Dolt issue or mapped CHG record. Missing evidence or any device/scope/diff
mismatch stops apply on the same issue with the smallest resume condition.
After approval, the executor applies only the approved diff and stops on any
deviation. Never record secrets or credentials in the approval evidence.

## Lifecycle Readback Checklist

### Start

- Resolve the explicit canonical mapping, or confirm project-local fallback.
- Run `bd prime`, `bd where`, `bd ready`, and `bd show <id>`.
- Confirm role, issue identity, dependencies, claim, and acceptance conditions.

### Stop for a Blocker

- Verify allowed PC automation paths read-only and try permitted reversible
  actions before concluding that human presence is required.
- Capture the failed command or path, external state, and refusal/impossibility;
  never test by expanding authority, exposing credentials, publishing, or making
  an irreversible change.
- Record one concrete blocker and its smallest resume condition on the same
  issue; read back status, assignee, and dependency state.
- Continue unrelated ready product issues before reporting.

### Resume

- Confirm the resume condition is now true.
- Resume the same assignee and same issue once; do not fork or duplicate it.
- Read back claim/status, then continue the delivery loop.

### Independent finding

- Match the finding to the canonical epic/issue ID and verify current status,
  dependencies, and the existing numbered remediation path.
- Dispatch that existing ready remediation issue to its executor in this review
  cycle, or record its one exact external blocker and minimum resume condition.
- Read back the dispatch or blocker; do not substitute a forwarded report,
  duplicate issue, stale `in_progress`, PMO implementation, or self-audit.

### Apply a live network configuration change

- Confirm read-only evidence, dry-run/design, rollback, and verifier preparation
  are complete before requesting approval.
- Read back fresh explicit owner approval from the canonical Dolt issue or
  mapped CHG record and match device, scope, diff, interruption, rollback, and
  verifier exactly; reject broad, stale, missing, or mismatched approval.
- Apply only the approved diff, stop on deviation, omit secrets from evidence,
  and record the verifier result on the same canonical workflow.

### Complete

- Verify the artifact and external acceptance facts.
- Run `scripts/quick_validate.js` against the canonical Epic and require exit
  `0` / `valid:true`; proxy-only or broken traces prohibit close.
- Add a concise reproducible evidence comment and close the issue.
- Read back closed status/evidence, run `bd ready`, and take the next product
  issue until the artifact or epic is genuinely complete.

## Canonical Mapping Examples

These are identity examples only. Never copy their live status into this file.
Always resolve the current mapping before use.

| Product | Canonical epic example |
|---|---|
| Skill Magnet | `sm-62a` |
| Codex Discord Voice Bridge | `cdvb-enj` |
| Codex Micro Android | `pmp-25l.3` in the explicitly mapped PM product ledger |
| News + Obsidian Pipeline | `nop-yd6` |
| Home Network | `hnb-cycle0` |
| Cangjie Skill | `csc-3zh` |
| M18 Deck | `pmp-25l.11` in the explicitly mapped PM product ledger |

## Beginner Spot-Checks

### A device step is safely automatable with ADB

Inspect device state first. If the requested step is available through already
authorized ADB and is reversible, the executor performs and verifies it. It does
not ask the user to tap merely because the equivalent UI action is physical.

### Browser automation proves human presence is required

Inspect the permitted browser/computer automation route and attempt only the
safe reversible action. If the browser or service explicitly refuses automation
and requires present-user interaction, record that refusal on the same issue and
set one human-presence blocker with the smallest action that resumes execution.

### The step is identity-bound MFA

Do not attempt to bypass or expose the person's MFA, biometric, or security key.
Record that one blocker and the exact completion signal needed to resume; PMO
may confirm it read-only and request one same-issue resume, but performs no step.

## Observable Acceptance Spot-Checks

### Windows Explorer context menu

Reject a close based only on registry hashes or unit tests. A separate shadow
Codex must right-click the intended target in the real Windows Explorer, see the
expected modern context-menu item, select it, and observe the specified Skill
Magnet action reach its user-visible result.

### Android pairing

Reject a close based only on APK, permissions, or Bluetooth logs. A separate
shadow Codex must use the target Android device and paired host, perform the
specified pairing/input flow, and observe the intended connection and behavior
on the actual devices. An environmental No-Go is valid only for that measured
environment and implementation.

### Discord Gateway

Reject a close based only on unit tests, dry-run events, or stored credentials.
A separate shadow Codex must use the approved real Discord environment, perform
the defined Gateway/voice action, and observe the expected ready/event/audio
behavior. If credentials or user presence are required, record the single true
blocker rather than claiming product completion.
