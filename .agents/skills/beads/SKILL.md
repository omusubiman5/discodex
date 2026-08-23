---
name: beads
description: Use Beads/Dolt as the durable work source when planning, executing, checking, or read-only coordinating product issues, while respecting an explicit canonical-ledger mapping when one exists.
---

# Beads

Use the explicitly mapped canonical product ledger for durable execution state.
Before an approved goal is accepted as a canonical epic, keep it in the existing
intake process. After acceptance, Beads alone owns children, dependencies,
status, assignee, evidence, and the single blocker; Markdown and HTML may retain
only a thin epic link and a `transferred` marker.

## Start

Run `bd prime`, then `bd where` if no workspace is shown. Prefer the installed
`bd` CLI. Resolve an explicit status-source or parent-goal mapping before reading
status; only projects without a mapping default to their project-local ledger.
Keep onboarding and product ledgers separate.

Choose exactly one role: owner, PMO, planner, executor, independent verifier, or
Beads/Dolt operator. Read [references/operations.md](references/operations.md)
for the role boundaries, complete delivery loop, Board/Graph policy, blocking
rules, canonical mapping examples, and lifecycle checklists.

## Invariants

- Search `project + normalized objective + deliverable + source reference`
  before creating an issue; reuse an exact match and stop on a similar match.
- Execution issues are atomic product increments. Do not create operational
  substitutes, duplicate trackers, or pre-implementation audits.
- Define the deliverable as one user-observable sentence. Acceptance includes
  who uses which real environment, what they operate, and what visibly works;
  internal hashes, registry state, or unit tests alone cannot prove completion.
- Assign product issues to a concrete agent role. Reject vague human-owned
  review/configuration/action issues unless failed automation proves one minimal
  identity-, presence-, physical-lock-, or irreversible-decision gate.
- Treat a live network-device configuration apply as a stronger exception:
  agents prepare evidence and rollback, but only fresh, exact owner approval may
  authorize the named device, scope, and diff.
- Never infer progress from an active UI, conversation, or self-report. Read the
  canonical Dolt ledger and verify external facts required by acceptance.
- An independent FAIL, route-specific No-Go, missing requirement, or missing
  evidence must dispatch the existing numbered remediation issue in the same
  review cycle; recording the report or leaving stale work is not follow-up.
- Do not use Markdown TODOs or custom HTML as execution ledgers. Do not use
  `bd edit`, auto-close incomplete work, merge separate ledgers, expose secrets,
  or expand permissions or safety boundaries to bypass a proven human gate.
- Read the applicable issue at the start and end of work. Executors continue
  through the next ready issue until the artifact is complete or one true
  external blocker remains.
- Before closing a product Issue or Epic, run the read-only close preflight in
  `scripts/quick_validate.js`. It must prove bidirectional Epic -> child Issue
  -> test -> evidence traceability for the external product URL, voice
  brain/agent identity, supported OS, and observable real E2E. A process,
  participant, counter, unit test, or internal transport observation alone is
  supporting evidence, never product acceptance.
