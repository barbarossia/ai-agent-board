# Phase 2 shared-contract acceptance (Phase 2.8)

Revision: 2026-09-24. This file is the traceable acceptance matrix for the shared contracts. Contracts are additive; legacy Board statuses, all seven provider identifiers, provider adapters, and production persistence remain outside this implementation.

## Acceptance matrix

| Requirement | Shared source / evidence | Result |
| --- | --- | --- |
| Phase 2.1–2.3 Task lifecycle retains four states and explicit transition matrix | `shared/types.ts`, `shared/constants.ts`, `packages/server/tests/task-lifecycle-contract.test.ts` | Passed; included in focused run below |
| Phase 2.2 Role create/update and immutable execution snapshot | shared Role validators and `packages/server/tests/role-contract.test.ts` | Passed; all seven existing providers remain accepted |
| Phase 2.4 Session state, ownership, current reference and recent result | shared Session helpers and `packages/server/tests/session-contract.test.ts` | Passed; included in focused run below |
| Phase 2.5 four Waiting reasons use one shared union; valid Waiting requires context; exit clears it; Human action is derived | `shared/waiting-contract.md`, shared validators, session contract tests | Passed; included in focused run below |
| Phase 2.6 Handoff owns both Task and corresponding Card, references Roles and an optional same-Task business Session, and appends by expected head | `shared/handoff-contract.md`, shared validators, `packages/server/tests/handoff-contract.test.ts` | Passed; includes two Task/Card pairs and two Sessions on one Task/Card |
| Phase 2.7 persistence fields, nullability, SQLite/PostgreSQL mapping, migration/backfill/rollback duties, and identity/version update conditions are specified without enabling storage | `shared/persistence-contract.md` | Specification only; no database migration/runtime persistence added |
| Phase 2.8 client/server use the shared type source; no provider path is changed | shared package exports, client type re-export, source audit | Shared, client, and server builds passed; no provider adapter was changed |

## Required validation evidence

Record commands, exit codes, relevant failures, and whether an observed failure reproduces on base. Shared, client, and server builds are required. Focused tests cover Role editing/snapshot, Task transitions, Session state/results/ownership, Waiting combinations, Handoff owner/session consistency, and Task/Card isolation. Run E2E only if a UI or route consumer is changed; this contract-only change adds no input control or provider behavior.

| Command | Purpose | Exit code / result |
| --- | --- | --- |
| `npm run build:shared` | Compile public shared contracts and exports | 0; passed |
| `node --import tsx/esm --test packages/server/tests/role-contract.test.ts packages/server/tests/task-lifecycle-contract.test.ts packages/server/tests/session-contract.test.ts packages/server/tests/handoff-contract.test.ts` | Focused Role/Task/Session/Waiting/Handoff contract regression tests | 0; 28 passed, 0 failed |
| `npm run build:client` | Verify client shared type consumption | 0; passed (existing large-chunk advisory emitted) |
| `npm run build:server` | Verify server shared type consumption | 0; passed |

`npm ci` was required because this worktree initially had no installed packages. It completed with a lockfile install and reported 5 audit advisories (4 moderate, 1 high); no automatic dependency or lockfile changes were made. Tests did not invoke a real Provider SDK or authenticated Agent CLI. No E2E run was needed because the change adds no route, UI, or provider behavior. No base-branch comparison was required because all focused tests and builds passed.

The tests use pure deterministic contract fixtures. They verify no live Provider SDK or authenticated Agent CLI was invoked. Real Provider execution is not claimed as tested. Database isolation remains a later backend task because Phase 2.7 intentionally adds no repositories/migrations.

## Downstream inputs and remaining boundary

- Phase 3–4 must define the authoritative adapter between new Task/Session lifecycle and legacy `ColumnId`, `AgentStatus`, and provider execution state before runtime wiring.
- Phase 5 may render Waiting reason and safe summary but must keep submitted input and approval payload outside `WaitingContext`.
- Phase 6 may consume the Handoff identity, owner pair, Role IDs, optional same-Task Session, timestamp, expected append head, and a future Artifact edge.
- SQLite/PostgreSQL persistence must implement and test transactional ownership/version checks before any production migration is enabled.
