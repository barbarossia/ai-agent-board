# Waiting reason and Human Gate display contract (Phase 2.5)

Revision: 2026-09-24. This is an additive business Session contract. `SessionState` remains the exact five-state set in `shared/types.ts`; Waiting is classified by `WaitingContext.reason`, not by a new top-level state.

## Shared shape

`WaitingReason` is the serialized union `human_input | local_action | approval | agent_wait`. `WaitingContext` contains only:

| Field | Type | Meaning |
| --- | --- | --- |
| `reason` | `WaitingReason` | Stable machine-readable classification. |
| `description` | nonblank string | Short, safe-to-display explanation; never raw user input, credentials, tokens, or other sensitive content. |
| `startedAt` | nonnegative integer timestamp | Beginning of this wait interval. |

The context contains no input values, approval payload, local command, secret, or action controls. The boundary cannot detect arbitrary secrets embedded in prose; callers must construct `description` from safe summaries. `requiresHumanAction(reason)` derives `true` for `human_input`, `local_action`, and `approval`, and `false` for `agent_wait`.

`validateWaitingContext(unknown)` rejects unknown fields and malformed values and returns a normalized serializable value. These types and validators are exported from the shared package and re-exported by the client type entry point. No client input, approval command, cancellation, Agent resume, or SDK recovery behavior is added.

## Combination and cleanup rules

- A `Session` in `Waiting` must carry a valid `waitingContext`.
- `transitionSession(session, 'Waiting', at, { waitingContext })` requires a valid context. A missing context or malformed context rejects without mutation.
- A repeated `Waiting → Waiting` transition preserves its context when omitted; a supplied valid context explicitly refreshes the displayed reason/summary.
- Every transition out of `Waiting` clears `waitingContext` to `null`. Non-Waiting transitions reject a supplied waiting context.
- New Sessions begin with `waitingContext: null`. `TaskLifecycleState`, Board `ColumnId`, `AgentStatus`, and Session's five states are unchanged.
- Cancellation is not modeled here. Existing `Failed` or other existing Session paths remain authoritative; there is no `Cancelled` state.

## Examples

Valid human gate:

```json
{"reason":"approval","description":"Review the requested operation.","startedAt":120}
```

Valid ordinary wait:

```json
{"reason":"agent_wait","description":"The Agent is processing the current step.","startedAt":140}
```

Invalid examples include an unsupported reason, a blank description, a missing timestamp, a `rawInput` field, or entering `Waiting` without a context. The display contract deliberately does not carry a secret-bearing form value.

## Phase 5 consumption

Phase 5 may render the reason, safe description, start time, and derived Human-action indicator. It must source the reason union from `@ai-agent-board/shared`, keep input/approval data outside this persisted display object, and provide controls only under its own explicit interaction contract. `agent_wait` is informational and does not by itself request Human action.
