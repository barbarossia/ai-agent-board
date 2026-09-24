# Task, Role, Session and Handoff reference contract (Phase 2.6)

Revision: 2026-09-24. This adds shared identity and ownership rules only. It does not create a Handoff table/repository, append endpoint, artifact store, or chain-ordering algorithm.

## Minimum record

`Handoff` is an immutable append-only reference with `id`, `taskId`, `cardId`, `sourceRoleId`, `targetRoleId`, nullable `sessionId`, nullable `sessionReferenceReason`, `createdAt`, and nullable `previousHandoffId`. `Task.handoff` is an optional `TaskHandoffAssociation` containing the same Task/Card owner pair and the `latestHandoffId`; missing association means no Handoff has been recorded. IDs are nonblank opaque identifiers. Role display names and Artifact data are not copied into this identity record.

`HandoffOwner` is resolved at the caller boundary from the durable Task and the Board Card that represents it. In the current Board model the Task is the card record; adapters must pass the verified pair and must not manufacture the pair from unrelated request fields. `createHandoff` requires both IDs to match this resolved owner.

## Relationship invariants

- Every Handoff belongs to exactly one Task and that Task's corresponding Card. A Task mismatch or Card mismatch is rejected before append.
- Source and target Role references must resolve when creating a new Handoff. They remain IDs, so later Role renames do not rewrite history.
- `sessionId` may be null only with an explicit `sessionReferenceReason` (`session_not_created` or `not_applicable`). A present Session ID must resolve to the same Task; cross-Task Session links are rejected.
- `previousHandoffId` is an optional/null chain candidate. `appendHandoff` requires it to equal the current Task/Card head and the caller's expected head. This detects stale writers without defining sorting, traversal, or reconciliation.
- Handoffs are frozen on creation. Appending advances only the Task/Card head; it never edits an existing Handoff.
- A manual Board drag, Task transition, or Human Gate completion does not create a Handoff implicitly. Only a later explicit workflow may call a Handoff append boundary.
- Artifact content and storage are future relationships only. No Artifact field or blob is part of this record.

## Valid and invalid examples

Valid Handoff without a Session:

```json
{"id":"handoff-1","taskId":"task-1","cardId":"card-1","sourceRoleId":"role-author","targetRoleId":"role-reviewer","sessionId":null,"sessionReferenceReason":"session_not_created","createdAt":1758700000000,"previousHandoffId":null}
```

Invalid cases include `taskId` or `cardId` disagreeing with the resolved owner, an unavailable Role, a null Session with no reason, a present Session from another Task, or an append based on a stale `previousHandoffId`.

`createHandoff`, `createTaskHandoffAssociation`, and `appendHandoff` are pure shared contract helpers. Storage still owns global ID uniqueness, transactions, and durable compare-and-swap behavior.

## Phase 6 interface inputs

Phase 6 can consume: resolved `{taskId, cardId}`, source and target Role IDs, optional same-Task business `sessionId`, null-reference reason when absent, caller-allocated Handoff ID, creation timestamp, and expected/current `previousHandoffId`. Any Artifact is a separate future edge keyed by Handoff identity. A future append API must carry Task/Card/session ownership and an expected head/version in one atomic write.
