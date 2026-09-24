# Board Card lifecycle adapter (Phase 3)

The Board UI stage and Task lifecycle are independent persisted fields. `boardStage` is one of `draft`, `inbox`, `research`, `implement`, `review`, or `knowledge`; `lifecycleState` remains `Draft`, `Inbox`, `Active`, or `Done`. Legacy `columnId` remains available to existing API consumers and is not updated by Board drags.

## Legacy row mapping

The one-time migration uses this explicit mapping:

| Legacy `columnId` | Board stage | Task lifecycle |
| --- | --- | --- |
| `backlog` | `draft` | `Draft` |
| `in-progress` | `implement` | `Active` |
| `review` | `review` | `Active` |
| `done` | `knowledge` | `Done` |

Unknown legacy column values keep their original database value and are returned as `legacyColumnId`; their Board stage and lifecycle remain null. The Board displays these records in a recovery notice, and stage transitions reject them until an explicit recovery is available.

## Human transition rules

Allowed stage moves are Draft → Inbox → Research → Implement → Review → Knowledge, plus Review → Implement for a rejected review. Every move is a server-validated command. One Task/Card is updated atomically with one immutable Handoff row. Each row includes the target stage and `actorId: human`, the Task/Card owner pair, source/target Role references, optional Session reference, and previous Handoff ID. Handoffs are available through `GET /api/tasks/:id/handoffs` and are never overwritten by later moves.

Every human drag, including Inbox admission and each later stage move, is checked by the configured Orchestrator before the stage, lifecycle, or Handoff is persisted. The request includes the Human-selected configured target Role and its instructions. A rejected, failed, unavailable, or timed-out validation leaves the prior Board stage and lifecycle in place and creates no Handoff. Successful Inbox admission validates Draft → Inbox and then Inbox → Active using the shared Task lifecycle contract. The validation run only updates Agent execution status; it does not execute the selected Role or move the Board Card itself. Research and later Role execution is deferred to Phase 4. Dragging into Knowledge keeps lifecycle Active; the separate completion action sends explicit `completionConfirmed: true` before the Task becomes Done.

The configured Orchestrator provider is honored. The current shared Agent SDK creates provider-level Sessions using the provider's configured default model; per-Role model snapshots and distinct business Session persistence remain Phase 4 work.
