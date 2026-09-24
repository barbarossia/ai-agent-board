# Persistence fields and update isolation (Phase 2.7)

Revision: 2026-09-24. This document is a logical storage specification for the Phase 2 shared contracts. **It is not a database schema or migration:** this phase adds no production migration, runtime repository, route, or table. The current Task repository persists legacy Board fields; business Role, Session, WaitingContext, Task association, and Handoff structures described here have no new SQLite/PostgreSQL migration. The mappings below are proposed projections for a future repository implementation.

## Mapping conventions and scope

- The SQLite and PostgreSQL types below describe equivalent storage representations. IDs, free text, provider names, enum literals, and nullable references use `TEXT` on SQLite and `TEXT` on PostgreSQL. Contract timestamps are nonnegative Unix epoch milliseconds (`INTEGER` on SQLite, `BIGINT` on PostgreSQL), not database-local timestamp values.
- Nested values are stored as one JSON aggregate (`TEXT` containing JSON on SQLite; `JSONB` on PostgreSQL). Their members are nevertheless enumerated individually below with logical types and member constraints. A backend may normalize them into columns if it preserves the same contract and atomicity.
- “No database default” means the application supplies the contract value; it does not authorize inventing one during backfill. An explicit default is listed where one is part of the shared contract.
- Proposed index names/columns are logical recommendations, not existing indexes. Do not add an index merely because a field is listed; use the specified access/uniqueness purpose.
- `Task.lifecycleState` is a shared transition vocabulary, not a persisted field on the current `Task` interface. Do not alias it to `columnId` or `agentStatus`; a later adapter must specify its own storage mapping.

## Role and execution snapshot inventory

`Role` is a settings-owned logical object. The table below gives a future relational projection if Roles are stored in SQLite/PostgreSQL; it does not claim a `roles` table currently exists. `RoleExecutionSnapshot` is copied into its Session as an immutable JSON aggregate and is independent of later Role edits.

| Logical field | Logical type; null/default | SQLite projection | PostgreSQL projection | Constraints and indexes | Backfill / migration / rollback |
| --- | --- | --- | --- | --- | --- |
| `Role.id` | string; required; caller-assigned stable identity; no default | `TEXT NOT NULL` | `TEXT NOT NULL` | Primary key/unique; never derive from name | New Role writes only. Do not infer IDs from display names. Rollback must retain referenced Role identities or tombstones. |
| `Role.name` | string; required, nonblank; no default | `TEXT NOT NULL` | `TEXT NOT NULL` | Nonblank validation; not unique unless product policy later requires it; no index required | No safe legacy identity mapping from name. No backfill. |
| `Role.responsibility` | string; required, nonblank; no default | `TEXT NOT NULL` | `TEXT NOT NULL` | Nonblank validation; no index | No inferred backfill. |
| `Role.instructions` | string; required, nonblank; no default | `TEXT NOT NULL` | `TEXT NOT NULL` | Nonblank validation; treat as Role configuration, not a Session snapshot substitute | No inferred backfill. Preserve historical Session snapshots on Role edits. |
| `Role.execution` | object; required; no default | `TEXT NOT NULL` containing JSON | `JSONB NOT NULL` | Validate provider/model together; no index | New valid configuration only; never reuse a model from another provider when provider changes. |
| `Role.execution.provider` | existing `ProviderType`; required; no default | JSON string in `execution` | JSON string in `execution` | Must be one of the seven existing provider wire values; no FK to a mutable Provider catalog | Preserve accepted provider values; no rewrite during migration. |
| `Role.execution.model` | string or null; required member; null means provider default | JSON string or JSON `null` | JSON string or JSON `null` | If string, trim/nonblank and scoped to `provider`; do not hard-code model catalog values | Null is meaningful; do not backfill with a guessed provider model. |
| `RoleExecutionSnapshot.roleId` | string; required | JSON string in `Session.roleExecutionSnapshot` | JSON string in `Session.role_execution_snapshot` | Stable Role identity captured at Session admission; no mutable Role FK requirement | Historical reference may outlive a Role. Never replace with a current Role ID. |
| `RoleExecutionSnapshot.name` | string; required, nonblank | JSON string in snapshot aggregate | JSON string in snapshot aggregate | Snapshot the selected display name | Missing legacy snapshot stays null as a whole; do not synthesize from the current Role. |
| `RoleExecutionSnapshot.responsibility` | string; required, nonblank | JSON string in snapshot aggregate | JSON string in snapshot aggregate | Captured value, immutable for that Session | Do not copy a later Role edit into an old Session. |
| `RoleExecutionSnapshot.instructions` | string; required, nonblank | JSON string in snapshot aggregate | JSON string in snapshot aggregate | Captured value; apply sensitive-data policy of Role configuration | Do not copy a later Role edit into an old Session. |
| `RoleExecutionSnapshot.execution` | object; required | JSON object in snapshot aggregate | JSON object in snapshot aggregate | Must contain both members below; immutable selection | Missing/unknown legacy selection stays absent only by keeping the enclosing snapshot null. |
| `RoleExecutionSnapshot.execution.provider` | `ProviderType`; required | JSON string in snapshot aggregate | JSON string in snapshot aggregate | Same seven-value provider union as `Role.execution.provider` | Preserve captured provider; do not infer from current Task agent status. |
| `RoleExecutionSnapshot.execution.model` | string or null; required member | JSON string or JSON `null` | JSON string or JSON `null` | If string, scoped to the captured provider; null means provider default | Preserve null; never fill from a later Role edit. |

The snapshot aggregate itself is a nullable field on Session; its SQLite/PostgreSQL column types, null behavior, and no-FK historical-reference policy are specified with Session below. JSON is the proposed encoding for nested snapshots, not an instruction to migrate current Settings files.

## Session, WaitingContext, and Task session association

Proposed logical relation names are `sessions` and `task_session_associations`. A repository may instead store the Task association as a versioned Task extension, provided ownership checks and atomic updates below are preserved.

| Logical field | Logical type; null/default | SQLite projection | PostgreSQL projection | Constraints and indexes | Backfill / migration / rollback |
| --- | --- | --- | --- | --- | --- |
| `Session.id` | string; required opaque ID; no default | `TEXT NOT NULL` | `TEXT NOT NULL` | Primary key; must differ from `taskId` | No Session rows exist in this contract. Allocate only on new execution admission; never reuse Task ID. |
| `Session.taskId` | string; required; no default | `TEXT NOT NULL` | `TEXT NOT NULL` | FK to `tasks(id)` when repository table mapping permits; index `(task_id, created_at)` for owner/time queries | Create Session only for verified Active Task; do not infer from Agent events. |
| `Session.state` | `SessionState`; required; new Session starts `Ready` | `TEXT NOT NULL DEFAULT 'Ready'` | `TEXT NOT NULL DEFAULT 'Ready'` | Check exact values `Ready`, `Running`, `Waiting`, `Completed`, `Failed`; terminal state immutable | Do not translate `AgentStatus`, `ColumnId`, or SDK state to infer a business state. |
| `Session.waitingContext` | `WaitingContext \| null`; required member; default `null` at creation | nullable `TEXT` containing JSON | nullable `JSONB` | Null outside `Waiting`; valid non-null context required in `Waiting`; no index | Legacy context/reason is not inferable. Non-Waiting rows may use null. A legacy Waiting row requires explicit trusted evidence before admission. |
| `WaitingContext.reason` | `WaitingReason`; required when context exists | JSON string in `waitingContext` | JSON string in `waiting_context` | Exact values `human_input`, `local_action`, `approval`, `agent_wait` | Never infer a reason from UI position, Agent status, or event text. |
| `WaitingContext.description` | string; required, nonblank when context exists | JSON string in `waitingContext` | JSON string in `waiting_context` | Safe display summary; raw input, credentials, and approval payload are prohibited by contract | No safe summary can be reconstructed from arbitrary legacy text; keep missing contexts null only where state permits. |
| `WaitingContext.startedAt` | nonnegative integer timestamp; required when context exists | JSON integer milliseconds | JSON integer milliseconds | Beginning of this wait interval; no default | Do not infer from Session `updatedAt` without authoritative source evidence. |
| `Session.createdAt` | nonnegative integer timestamp; required; no database default | `INTEGER NOT NULL` | `BIGINT NOT NULL` | Immutable admission time; index with `task_id` as above | Only source evidence may populate legacy time. Do not silently use migration time. |
| `Session.updatedAt` | nonnegative integer timestamp; required; on create equals `createdAt` | `INTEGER NOT NULL` | `BIGINT NOT NULL` | Monotone on accepted state/context/result update | Do not alias legacy Task timestamps. No arbitrary backfill. |
| `Session.startedAt` | timestamp or null; required member; default `null` until first start | nullable `INTEGER` | nullable `BIGINT` | Set on first `Ready → Running`; preserve on resume | Null remains null if no authoritative start event exists. |
| `Session.endedAt` | timestamp or null; required member; default `null` until terminal transition | nullable `INTEGER` | nullable `BIGINT` | Non-null only for `Completed` or `Failed`; terminal time | Do not derive from Task completion time or provider event without verified mapping. |
| `Session.roleExecutionSnapshot` | snapshot object or null; required member; default `null` for legacy/unconfigured work | nullable `TEXT` containing JSON | nullable `JSONB` | No mutable Role FK; if non-null, all snapshot members listed above are required; no index | Leave null when no trustworthy captured selection exists. Never copy current Role values into an old execution. |
| `Session.executionAttemptId` | string or null; required member; default `null` | nullable `TEXT` | nullable `TEXT` | FK to immutable execution attempt when a compatible table relation exists; index only if queried | Null for old attempts without a Session; do not synthesize an attempt. |
| `Session.sdkSessionId` | string or null; required member; default `null` | nullable `TEXT` | nullable `TEXT` | No global uniqueness: provider namespace is not represented here; add provider-scoped uniqueness only with a future adapter | Never synthesize from business Session ID. |
| `TaskSessionAssociation.taskId` | string; required owner ID; no default | `TEXT NOT NULL` | `TEXT NOT NULL` | Primary key and FK to Task; one association per Task | Existing Tasks may have no association; do not infer one from legacy Agent fields. |
| `TaskSessionAssociation.currentSessionId` | string or null; required member; default `null` before first execution | nullable `TEXT` | nullable `TEXT` | FK to Session; referenced Session must have the same `taskId`; unique reference if required by repository access pattern | Existing Tasks start null. Never infer the current Session from status or event recency. |
| `TaskSessionAssociation.recentResult` | `SessionRecentResult` or null; required member; default `null` until terminal result | nullable `TEXT` containing JSON | nullable `JSONB` | Keep separate from current Session; if present, referenced Session must belong to the same Task and be terminal; no index unless queried | Existing Tasks start null; do not derive from event prose. |
| `SessionRecentResult.sessionId` | string; required when result exists | JSON string in `recentResult` | JSON string in `recent_result` | Session identity; same Task owner; index not required inside aggregate | No inferred mapping from old execution events. |
| `SessionRecentResult.outcome` | `'success' \| 'failure'`; required | JSON string in aggregate | JSON string in aggregate | Success requires null error; failure requires nonblank error | Do not infer success/failure solely from Task `agentStatus`. |
| `SessionRecentResult.completedAt` | nonnegative integer timestamp; required | JSON integer milliseconds | JSON integer milliseconds | Terminal completion time; no default | Use only an authoritative Session terminal event; do not use migration time. |
| `SessionRecentResult.summary` | string or null; required member | JSON string or JSON `null` | JSON string or JSON `null` | Optional safe summary; no index | Null if no trustworthy safe summary exists; do not turn raw input into a summary. |
| `SessionRecentResult.error` | string or null; required member | JSON string or JSON `null` | JSON string or JSON `null` | Nonblank when outcome is failure; null when success | Preserve null when no verified error exists; do not infer from unrelated event text. |

## Handoff and Task/Card association

Proposed logical relations are `handoffs` and `task_handoff_associations`. They are specifications only; no Handoff table, storage API, chain algorithm, or Artifact storage is introduced in this phase.

| Logical field | Logical type; null/default | SQLite projection | PostgreSQL projection | Constraints and indexes | Backfill / migration / rollback |
| --- | --- | --- | --- | --- | --- |
| `Handoff.id` | string; required opaque ID; no default | `TEXT NOT NULL` | `TEXT NOT NULL` | Primary key/unique | New explicit append only; no legacy backfill. |
| `Handoff.taskId` | string; required owner ID | `TEXT NOT NULL` | `TEXT NOT NULL` | FK to Task where available; must match resolved Task/Card owner pair | Do not infer Handoffs from manual card movement or approval history. |
| `Handoff.cardId` | string; required owner ID | `TEXT NOT NULL` | `TEXT NOT NULL` | Must identify the Card corresponding to `taskId`; composite owner index `(task_id, card_id, created_at)` | No legacy ownership inference; card mapping checked at write time. |
| `Handoff.sourceRoleId` | string; required | `TEXT NOT NULL` | `TEXT NOT NULL` | Historical Role identity; no cascading delete | Preserve ID when Role is unavailable; no display-name backfill. |
| `Handoff.targetRoleId` | string; required | `TEXT NOT NULL` | `TEXT NOT NULL` | Historical Role identity; no cascading delete | Preserve ID when Role is unavailable; no display-name backfill. |
| `Handoff.sessionId` | string or null; required member; default null only when paired with a reason | nullable `TEXT` | nullable `TEXT` | FK to Session when non-null; Session must have the same Task; no cross-Task link | Keep null explicit; never infer a Session link. |
| `Handoff.sessionReferenceReason` | reason or null; required member; default null only with non-null `sessionId` | nullable `TEXT` | nullable `TEXT` | Exactly `session_not_created` or `not_applicable`; required iff `sessionId` is null; null iff Session exists | Do not guess why no Session link exists. |
| `Handoff.createdAt` | nonnegative integer timestamp; required; no default | `INTEGER NOT NULL` | `BIGINT NOT NULL` | Immutable creation time; indexed as part of owner/time index | No ordering reconstruction from unrelated legacy events. |
| `Handoff.previousHandoffId` | string or null; required member; default null for first append | nullable `TEXT` | nullable `TEXT` | Optional self-reference; referenced Handoff must share Task/Card owner; no chain ordering algorithm defined here | No inferred predecessor. Retain existing append history on rollback. |
| `TaskHandoffAssociation.taskId` | string; required owner ID | `TEXT NOT NULL` | `TEXT NOT NULL` | Composite primary/unique owner key with `cardId`; Task FK where available | Existing Tasks have no association unless explicitly appended. |
| `TaskHandoffAssociation.cardId` | string; required owner ID | `TEXT NOT NULL` | `TEXT NOT NULL` | Must resolve to the Card paired with `taskId`; unique `(task_id, card_id)` | Do not reconstruct association from UI card position. |
| `TaskHandoffAssociation.latestHandoffId` | string or null; required member; default `null` before first append | nullable `TEXT` | nullable `TEXT` | FK to Handoff when non-null; referenced Handoff must match both owner IDs; index only if head lookup needs one | Existing associations start null. Advance atomically with the Handoff insert; never infer latest from timestamps. |

Handoff references do not make manual drag, Human Gate completion, or approval completion an implicit Handoff. Artifacts remain a future edge and are not stored in these structures.

## Migration, validation, and rollback responsibility

| Structure | Legacy source and safe backfill | Minimum rollout / rollback rule |
| --- | --- | --- |
| Role and Role execution | Current Settings ownership is authoritative; do not migrate it into a database as part of this phase. If a later repository projection is approved, preserve stable IDs and provider/model pairing. | Deploy readers that tolerate historical Role IDs before enabling writes. Use tombstones/restricted deletion while referenced. |
| Session and Role snapshot | No business Sessions exist in the current contract storage. Do not synthesize Sessions from Task state, Agent events, or SDK IDs. | Add nullable/compatible storage first; write new Sessions only after the adapter is deployed. Keep snapshots immutable. |
| WaitingContext | No safe reason or summary can be inferred for legacy waits. | Require valid context when entering Waiting; a legacy Waiting record needs explicit trusted evidence. |
| TaskSessionAssociation and recent result | Existing Tasks begin without association (`null`/no row). Old Task agent events are not a result source. | Update association and Session result state in one transaction. A rollback reader must ignore or safely preserve the extension. |
| Handoff and TaskHandoffAssociation | No historical Handoff exists; manual movement and approval history are not Handoffs. | Append immutable rows and advance the owner head atomically. Never delete/rewrite append-only history during rollback. |

No default should fabricate timestamps, IDs, Role snapshots, Waiting reasons, results, Session references, or Handoff predecessors. Adding nullable fields or tables is forward-compatible only while old readers can ignore them. Rollback must retain new rows/columns and use a compatible reader; destructive rollback needs a separately reviewed export/restore plan. **No migration is executed by Phase 2.7.**

## Conditional update and isolation contract

Every write names its owner and expected identity/version:

- Session transition or result: `taskId + sessionId + expected state/version`. Update the Session and the Task's `currentSessionId`/`recentResult` in one transaction when both are affected.
- Waiting context: update only the named Session while it is the expected current Session; enforce the Waiting/context pairing in the same write.
- Handoff append: `taskId + cardId + expected latestHandoffId/version + new handoffId`. Verify Task/Card, Role and optional Session references, insert the immutable row, then advance the matching Task/Card head atomically.
- SQLite performs compare-and-swap inside a write transaction. PostgreSQL uses row locks or conditional `UPDATE ... WHERE owner_id = ? AND version = ?`, then checks affected-row count. Never read a head, release the transaction, and overwrite it unconditionally.

| Condition | Required result |
| --- | --- |
| No Task/Card/Session owner matches | Return not-found/ownership conflict; do not write another owner's record. |
| Expected state/version/head is stale | Return a stable conflict; preserve stored state and require caller reload. Do not silently retry with a refreshed head. |
| Duplicate Session/Handoff ID | Return duplicate identity; identical replay is allowed only if a future API explicitly defines idempotency. |
| Late result from a non-current Session | Reject as stale and leave current Session and recent result unchanged. |
| Two Sessions under one Task | Only the Session matching current Session ID/version may update `recentResult`; preserve the prior terminal result until the current Session terminates. |
| Handoff Task/Card pair or Session owner mismatches | Reject before append/head update; no partial write. |

The contract tests use two Task/Card pairs and two execution identities under one pair. A future persistence implementation must repeat those cases against both database backends and verify transactional atomicity and affected-row counts.

## Role reference invalidation

Role edits preserve `Role.id`; each Session snapshot preserves the execution choice captured at admission. Existing snapshots and Handoff Role IDs remain readable historical references if a Role is unavailable. New Handoff creation rejects an unresolved source or target Role. Role deletion must be restricted while live references exist or use a tombstone policy; it must never cascade-delete Sessions or Handoffs.
