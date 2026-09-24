# Persistence fields and update isolation (Phase 2.7)

Revision: 2026-09-24. This is the migration/repository specification for the Phase 2 shared contracts. This phase adds no production migration, runtime repository, route, or schema change. The current Task repository stores legacy Board fields; business Session and Handoff storage is not wired yet. The mappings below are future responsibilities for the existing SQLite/PostgreSQL repository boundary.

## Field and schema impact inventory

| Contract field | Owner / nullability / default | SQLite mapping | PostgreSQL mapping | Constraints and indexes | Backfill / migration rule |
| --- | --- | --- | --- | --- | --- |
| `Session.id` | Session; required opaque ID | `TEXT NOT NULL` | `TEXT NOT NULL` | PK or unique within the agreed ID scope | No Session rows exist in the current persistence contract; allocate only on new execution admission. |
| `Session.taskId` | Session; required | `TEXT NOT NULL` | `TEXT NOT NULL` | FK to `tasks(id)`; index `(task_id, created_at)` | New Session only; do not infer Sessions from Task agent events. |
| `Session.state` | Session; required, starts `Ready` | `TEXT NOT NULL DEFAULT 'Ready'` | `TEXT NOT NULL DEFAULT 'Ready'` | Check against `Ready, Running, Waiting, Completed, Failed` | Do not infer business state from `AgentStatus`, `ColumnId`, or SDK state. |
| `Session.waitingContext` | Session; nullable; `null` outside `Waiting` | Nullable `TEXT` containing JSON | Nullable `JSONB` | Application check: `Waiting` iff valid context; index not needed | Existing records cannot infer a safe reason or description. Backfill to null only for non-Waiting/legacy records; any legacy Waiting row requires explicit operator/source evidence before admission. |
| `Session.roleExecutionSnapshot` | Session; nullable for legacy/unconfigured work | Nullable `TEXT` JSON | Nullable `JSONB` | No mutable Role FK; preserve captured snapshot | Keep null when no trustworthy snapshot exists; never copy current Role values into old executions. |
| `Session.executionAttemptId` | Session; nullable | Nullable `TEXT` | Nullable `TEXT` | FK to existing immutable attempt when table-level relationship is available; index only if queried | Null for old attempts without a Session. |
| `Session.sdkSessionId` | Session; nullable | Nullable `TEXT` | Nullable `TEXT` | Provider-scoped uniqueness only if a future adapter requires it | Never synthesize from business Session ID. |
| `Task.session.currentSessionId` | Task association; nullable before first execution | Nullable `TEXT`/JSON extension | Nullable `TEXT`/JSON extension | FK to Session plus owner check; current Session index | Existing Tasks start with null; do not infer current Session from old Agent status. |
| `Task.session.recentResult` | Task association; nullable until terminal result | Nullable `TEXT` JSON | Nullable `JSONB` | Keep separate from current Session; index only if queried | Existing Tasks start with null; do not derive a result from event text. |
| `Handoff.id` | Handoff; required opaque ID | `TEXT NOT NULL` | `TEXT NOT NULL` | PK/unique | New explicit Handoff append only. No legacy backfill. |
| `Handoff.taskId`, `Handoff.cardId` | Handoff owner pair; required | `TEXT NOT NULL` each | `TEXT NOT NULL` each | Task FK; composite owner validation against the resolved Task/Card mapping; index `(task_id, card_id, created_at)` | No Handoff rows exist; do not infer from manual drag or approval history. |
| `Handoff.sourceRoleId`, `targetRoleId` | Handoff; required IDs | `TEXT NOT NULL` each | `TEXT NOT NULL` each | Role reference policy below; no cascade | Retain IDs for history; no display-name copy/backfill. |
| `Handoff.sessionId` | Handoff; nullable with reason | Nullable `TEXT` | Nullable `TEXT` | FK to Session; same-task ownership check | Null remains explicit; no inferred Session link. |
| `Handoff.sessionReferenceReason` | Handoff; required iff sessionId is null | Nullable `TEXT` | Nullable `TEXT` | Check reason in `session_not_created, not_applicable`; pair constraint with sessionId | Required for new null links; no default that guesses intent. |
| `Handoff.createdAt`, `previousHandoffId` | Handoff; timestamp required, predecessor nullable | `INTEGER` / nullable `TEXT` | `BIGINT` / nullable `TEXT` | Nonnegative timestamp; predecessor FK scoped to same Task/Card; unique append identity | New append supplies creation time and expected current head; no ordering reconstruction from unrelated rows. |
| `Task.handoff.latestHandoffId` | Task/Card association; nullable before first append | Nullable `TEXT` | Nullable `TEXT` | FK to Handoff plus owner check; unique owner pair | Existing Tasks start null. Update in same transaction as Handoff append. |

These mappings are proposed logical types, not assertions that `sessions` or `handoffs` tables exist today. JSON encoding must be stable and schema-versioned before rollout. The legacy Task columns (`column_id`, `agent_status`, timestamps, and provider fields) remain unchanged and are not aliases for the Phase 2 lifecycle/session fields.

## Conditional update contract

Every update names its owner and expected identity/version:

- Session transition/result: `taskId + sessionId + expected state/version`. Update the Session and the Task's `currentSessionId`/`recentResult` in one transaction when both are affected.
- Waiting context: update only the named Session while it is the expected current Session; enforce the Waiting/context pairing in the same write.
- Handoff append: `taskId + cardId + expected latestHandoffId/version + new handoffId`. Verify the Handoff's Task, Card, Session and Role references, insert the immutable row, then advance the matching Task/Card head atomically.
- SQLite should perform the compare-and-swap inside a write transaction; PostgreSQL should use row locks or conditional `UPDATE ... WHERE owner_id = ? AND version = ?` and check the affected-row count. Never read a head, release the transaction, then overwrite it unconditionally.

| Condition | Required result |
| --- | --- |
| No Task/Card/Session identity matches | Return not-found/ownership conflict; do not insert or update another owner's record. |
| Expected state/version/head is stale | Return a stable conflict; preserve stored state and require caller reload. No silent retry with a refreshed head. |
| Duplicate Session/Handoff ID | Return duplicate identity; an identical replay may be returned only if a future API explicitly defines idempotency. This contract helper rejects known duplicate Handoff IDs. |
| Late result from a non-current Session | Reject as stale and leave current Session and recent result unchanged. |
| Two Sessions under the same Task | Only a Session matching the current Session ID/version may update `recentResult`; the prior terminal result remains until the current Session terminates. |

The validation evidence in `handoff-contract.test.ts` uses two Task/Card pairs and two execution identities under one pair to prove isolation at the shared contract boundary. A later persistence implementation must repeat those cases against both real database backends and verify affected-row counts/transactions.

## Role reference invalidation and rollback

Role edits preserve `Role.id`; snapshots preserve the execution choice captured by a Session. If a Role is unavailable/deleted, existing Session snapshots and Handoff Role IDs remain readable as historical references, with an unavailable display label. New Handoff creation rejects an unresolved source or target Role. Role deletion must be restricted while live references exist or use a tombstone policy; it must not cascade-delete Sessions or Handoffs.

Adding nullable fields/tables is forward-compatible only while old readers ignore them. Rollback must retain new rows/columns and use a compatible reader; do not drop or rewrite append-only Handoff history as rollback cleanup. Destructive schema rollback requires a separately reviewed export/restore plan. No migration is executed by Phase 2.7.
