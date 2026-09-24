import type {
  ColumnId, BoardStageId, Priority, AgentStatus, AgentType, CreateRoleInput, UpdateRoleInput,
  Role, RoleContractError, RoleContractResult, RoleExecutionSnapshot, RoleId, ThinkingEffort,
  TaskLifecycleAction, TaskLifecycleResult, TaskLifecycleState,
  TaskLifecycleTransition, TaskLifecycleTransitionContext,
  CreateSessionInput, Session, SessionContractError, SessionContractResult,
  SessionRecentResult, SessionResultInput, SessionState, SessionStateAction,
  SessionStateResult, SessionStateTransition, TaskSessionAssociation,
  WaitingContext, WaitingContextError, WaitingContextResult, WaitingReason,
  Handoff, HandoffContractError, HandoffContractResult,
  HandoffOwner, HandoffSessionReferenceReason, TaskHandoffAssociation,
} from './types.js';

export const VALID_PRIORITIES: readonly Priority[] = ['low', 'medium', 'high', 'critical'] as const;
export const VALID_COLUMNS: readonly ColumnId[] = ['backlog', 'in-progress', 'review', 'done'] as const;
export const BOARD_STAGE_ORDER: readonly BoardStageId[] = ['draft', 'inbox', 'research', 'implement', 'review', 'knowledge'] as const;
export const BOARD_STAGE_ROLE: Readonly<Partial<Record<BoardStageId, string>>> = {
  inbox: 'orchestrator', research: 'research', implement: 'implementor', review: 'reviewer', knowledge: 'knowledge',
};
export const BOARD_STAGE_TRANSITIONS: Readonly<Record<BoardStageId, readonly BoardStageId[]>> = {
  draft: ['inbox'], inbox: ['research'], research: ['implement'], implement: ['review'],
  review: ['implement', 'knowledge'], knowledge: [],
};
export const VALID_AGENT_STATUSES: readonly AgentStatus[] = ['idle', 'planning', 'executing', 'complete', 'failed'] as const;
export const VALID_AGENT_TYPES: readonly AgentType[] = ['copilot', 'claude', 'codex', 'opencode', 'hermes', 'openclaw', 'grok'] as const;
export const VALID_THINKING_EFFORTS: readonly ThinkingEffort[] = ['low', 'medium', 'high'] as const;
export const BUILT_IN_ROLE_IDS: readonly RoleId[] = ['orchestrator', 'research', 'implementor', 'reviewer', 'knowledge'] as const;

export const VALID_TASK_LIFECYCLE_STATES: readonly TaskLifecycleState[] = ['Draft', 'Inbox', 'Active', 'Done'] as const;

const lifecycleTransition = (
  from: TaskLifecycleState,
  to: TaskLifecycleState,
  action: TaskLifecycleAction,
  requiresCompletionConfirmation = false,
): TaskLifecycleTransition => ({
  from,
  to,
  action,
  ...(requiresCompletionConfirmation ? { requiresCompletionConfirmation: true } : {}),
});

/** Complete 4 × 4 matrix. Null entries are intentionally explicit invalid transitions. */
export const TASK_LIFECYCLE_TRANSITIONS: Readonly<Record<TaskLifecycleState, Readonly<Record<TaskLifecycleState, TaskLifecycleTransition | null>>>> = {
  Draft: {
    Draft: lifecycleTransition('Draft', 'Draft', 'noop'),
    Inbox: lifecycleTransition('Draft', 'Inbox', 'submit'),
    Active: null,
    Done: null,
  },
  Inbox: {
    Draft: lifecycleTransition('Inbox', 'Draft', 'withdraw'),
    Inbox: lifecycleTransition('Inbox', 'Inbox', 'noop'),
    Active: lifecycleTransition('Inbox', 'Active', 'qualify'),
    Done: null,
  },
  Active: {
    Draft: null,
    Inbox: lifecycleTransition('Active', 'Inbox', 'retry'),
    Active: lifecycleTransition('Active', 'Active', 'noop'),
    Done: lifecycleTransition('Active', 'Done', 'complete', true),
  },
  Done: {
    Draft: null,
    Inbox: lifecycleTransition('Done', 'Inbox', 'reopen'),
    Active: null,
    Done: lifecycleTransition('Done', 'Done', 'noop'),
  },
};

export function isValidTaskLifecycleState(value: unknown): value is TaskLifecycleState {
  return typeof value === 'string'
    && (VALID_TASK_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function getTaskLifecycleTransition(from: unknown, to: unknown): TaskLifecycleResult {
  if (!isValidTaskLifecycleState(from) || !isValidTaskLifecycleState(to)) {
    return {
      ok: false,
      error: {
        code: 'invalid_state',
        from,
        to,
        message: 'Task lifecycle state must be one of Draft, Inbox, Active, or Done.',
      },
    };
  }
  const transition = TASK_LIFECYCLE_TRANSITIONS[from][to];
  if (!transition) {
    return {
      ok: false,
      error: {
        code: 'invalid_transition',
        from,
        to,
        message: `Task lifecycle cannot transition from ${from} to ${to}.`,
      },
    };
  }
  return { ok: true, state: to, transition };
}

/** Pure state transition; callers must provide explicit completion evidence for Active → Done. */
export function transitionTaskLifecycle(
  from: unknown,
  to: unknown,
  context: TaskLifecycleTransitionContext = {},
): TaskLifecycleResult {
  const result = getTaskLifecycleTransition(from, to);
  if (!result.ok) return result;
  if (result.transition.requiresCompletionConfirmation && context.completionConfirmed !== true) {
    return {
      ok: false,
      error: {
        code: 'completion_confirmation_required',
        from,
        to,
        message: 'Active → Done requires explicit completion confirmation.',
      },
    };
  }
  return result;
}

export const VALID_SESSION_STATES: readonly SessionState[] = ['Ready', 'Running', 'Waiting', 'Completed', 'Failed'] as const;

export const VALID_WAITING_REASONS: readonly WaitingReason[] = ['human_input', 'local_action', 'approval', 'agent_wait'] as const;

export function isValidWaitingReason(value: unknown): value is WaitingReason {
  return typeof value === 'string' && (VALID_WAITING_REASONS as readonly string[]).includes(value);
}

/** The first three Waiting reasons need a Human action; agent_wait is ordinary Agent progress. */
export function requiresHumanAction(reason: unknown): boolean {
  return reason === 'human_input' || reason === 'local_action' || reason === 'approval';
}

export function validateWaitingContext(input: unknown): WaitingContextResult<WaitingContext> {
  if (!isRoleObject(input)) {
    return { ok: false, errors: [{ code: 'invalid_type', path: '', message: 'Expected a Waiting context object.' }] };
  }
  const errors: WaitingContextError[] = [];
  for (const key of Object.keys(input)) {
    if (!['reason', 'description', 'startedAt'].includes(key)) {
      errors.push({ code: 'unknown_field', path: key, message: 'Field is not part of the safe Waiting display contract.' });
    }
  }
  if (!Object.hasOwn(input, 'reason')) errors.push({ code: 'required', path: 'reason', message: 'Waiting reason is required.' });
  else if (!isValidWaitingReason(input.reason)) errors.push({ code: 'invalid_type', path: 'reason', message: 'Expected a supported Waiting reason.' });
  if (!Object.hasOwn(input, 'description')) errors.push({ code: 'required', path: 'description', message: 'Safe display description is required.' });
  else if (typeof input.description !== 'string') errors.push({ code: 'invalid_type', path: 'description', message: 'Expected a string.' });
  else if (!input.description.trim()) errors.push({ code: 'blank', path: 'description', message: 'Description must not be blank.' });
  if (!Object.hasOwn(input, 'startedAt')) errors.push({ code: 'required', path: 'startedAt', message: 'Waiting start timestamp is required.' });
  else if (!isTimestamp(input.startedAt)) errors.push({ code: 'invalid_timestamp', path: 'startedAt', message: 'Expected a nonnegative integer timestamp.' });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      reason: input.reason as WaitingReason,
      description: (input.description as string).trim(),
      startedAt: input.startedAt as number,
    },
  };
}

const sessionTransition = (
  from: SessionState,
  to: SessionState,
  action: SessionStateAction,
): SessionStateTransition => ({ from, to, action });

/** Complete 5 × 5 matrix. Completed and Failed are terminal and cannot recover in place. */
export const SESSION_STATE_TRANSITIONS: Readonly<Record<SessionState, Readonly<Record<SessionState, SessionStateTransition | null>>>> = {
  Ready: {
    Ready: sessionTransition('Ready', 'Ready', 'noop'),
    Running: sessionTransition('Ready', 'Running', 'start'),
    Waiting: null,
    Completed: null,
    Failed: null,
  },
  Running: {
    Ready: null,
    Running: sessionTransition('Running', 'Running', 'noop'),
    Waiting: sessionTransition('Running', 'Waiting', 'wait'),
    Completed: sessionTransition('Running', 'Completed', 'complete'),
    Failed: sessionTransition('Running', 'Failed', 'fail'),
  },
  Waiting: {
    Ready: null,
    Running: sessionTransition('Waiting', 'Running', 'resume'),
    Waiting: sessionTransition('Waiting', 'Waiting', 'noop'),
    Completed: sessionTransition('Waiting', 'Completed', 'complete'),
    Failed: sessionTransition('Waiting', 'Failed', 'fail'),
  },
  Completed: {
    Ready: null,
    Running: null,
    Waiting: null,
    Completed: sessionTransition('Completed', 'Completed', 'noop'),
    Failed: null,
  },
  Failed: {
    Ready: null,
    Running: null,
    Waiting: null,
    Completed: null,
    Failed: sessionTransition('Failed', 'Failed', 'noop'),
  },
};

export function isValidSessionState(value: unknown): value is SessionState {
  return typeof value === 'string' && (VALID_SESSION_STATES as readonly string[]).includes(value);
}

export function getSessionStateTransition(from: unknown, to: unknown): SessionStateResult {
  if (!isValidSessionState(from) || !isValidSessionState(to)) {
    return {
      ok: false,
      error: {
        code: 'invalid_state',
        from,
        to,
        message: 'Session state must be one of Ready, Running, Waiting, Completed, or Failed.',
      },
    };
  }
  const transition = SESSION_STATE_TRANSITIONS[from][to];
  if (!transition) {
    return {
      ok: false,
      error: {
        code: from === 'Completed' || from === 'Failed' ? 'terminal_state_immutable' : 'invalid_transition',
        from,
        to,
        message: from === 'Completed' || from === 'Failed'
          ? `Terminal Session state ${from} cannot transition to ${to}.`
          : `Session cannot transition from ${from} to ${to}.`,
      },
    };
  }
  return { ok: true, state: to, transition };
}

export function transitionSessionState(from: unknown, to: unknown): SessionStateResult {
  return getSessionStateTransition(from, to);
}

function sessionError(code: SessionContractError['code'], path: string, message: string): SessionContractResult<never> {
  return { ok: false, errors: [{ code, path, message }] };
}

function isNonblankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * A Session owns an immutable copy of its Role selection.  Do not keep a
 * caller-owned RoleExecutionSnapshot here: later Role edits (or a mutable
 * input object) must not rewrite execution history.
 */
function normalizeRoleExecutionSnapshot(
  value: unknown,
  error: (code: SessionContractError['code'], path: string, message: string) => void,
): RoleExecutionSnapshot | null {
  if (value === null || value === undefined) return null;
  if (!isRoleObject(value)) {
    error('invalid_type', 'roleExecutionSnapshot', 'Expected a Role execution snapshot or null.');
    return null;
  }

  const known = ['roleId', 'name', 'responsibility', 'instructions', 'execution'];
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) error('invalid_type', `roleExecutionSnapshot.${key}`, 'Unknown Role execution snapshot field.');
  }
  for (const key of ['roleId', 'name', 'responsibility', 'instructions']) {
    if (!Object.hasOwn(value, key) || !isNonblankString(value[key])) {
      error('invalid_type', `roleExecutionSnapshot.${key}`, 'Expected a nonblank string.');
    }
  }
  if (!isRoleObject(value.execution)) {
    error('invalid_type', 'roleExecutionSnapshot.execution', 'Expected a Role execution configuration.');
    return null;
  }
  for (const key of Object.keys(value.execution)) {
    if (key !== 'provider' && key !== 'model') error('invalid_type', `roleExecutionSnapshot.execution.${key}`, 'Unknown Role execution configuration field.');
  }
  if (!isValidAgentType(value.execution.provider)) {
    error('invalid_type', 'roleExecutionSnapshot.execution.provider', 'Expected a supported provider identifier.');
  }
  if (value.execution.model !== null && !isNonblankString(value.execution.model)) {
    error('invalid_type', 'roleExecutionSnapshot.execution.model', 'Expected a nonblank model string or null.');
  }

  if (
    !isNonblankString(value.roleId)
    || !isNonblankString(value.name)
    || !isNonblankString(value.responsibility)
    || !isNonblankString(value.instructions)
    || !isValidAgentType(value.execution.provider)
    || (value.execution.model !== null && !isNonblankString(value.execution.model))
  ) return null;

  return Object.freeze({
    roleId: value.roleId,
    name: value.name,
    responsibility: value.responsibility,
    instructions: value.instructions,
    execution: Object.freeze({ provider: value.execution.provider, model: value.execution.model ?? null }),
  });
}

/** Validate a new business Session before storage; IDs are caller-owned and globally unique. */
export function validateCreateSession(
  taskState: unknown,
  input: unknown,
  existingSessionIds: Iterable<string> = [],
): SessionContractResult<CreateSessionInput> {
  const errors: SessionContractError[] = [];
  const error = (code: SessionContractError['code'], path: string, message: string) => errors.push({ code, path, message });
  if (taskState !== 'Active') error('task_not_active', 'taskState', 'A Session can only be admitted for an Active Task.');
  if (!isRoleObject(input)) return sessionError('invalid_type', '', 'Expected a Session input object.');
  const known = ['id', 'taskId', 'createdAt', 'roleExecutionSnapshot', 'executionAttemptId', 'sdkSessionId'];
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) error('invalid_type', key, 'Unknown Session input field.');
  }
  for (const key of ['id', 'taskId']) {
    if (!Object.hasOwn(input, key)) error('required', key, 'Field is required.');
    else if (!isNonblankString(input[key])) error('blank', key, 'Field must be a nonblank string.');
  }
  if (isNonblankString(input.id) && isNonblankString(input.taskId) && input.id === input.taskId) {
    error('same_as_task', 'id', 'Session ID must be distinct from Task ID.');
  }
  if (!Object.hasOwn(input, 'createdAt')) error('required', 'createdAt', 'Creation timestamp is required.');
  else if (!isTimestamp(input.createdAt)) error('invalid_type', 'createdAt', 'Expected a nonnegative integer timestamp.');
  const roleExecutionSnapshot = normalizeRoleExecutionSnapshot(input.roleExecutionSnapshot, error);
  for (const key of ['executionAttemptId', 'sdkSessionId']) {
    if (Object.hasOwn(input, key) && !isStringOrNull(input[key])) {
      error('invalid_type', key, 'Expected a string or null.');
    } else if (Object.hasOwn(input, key) && input[key] !== null && !isNonblankString(input[key])) {
      error('blank', key, 'Identifier must not be blank.');
    }
  }
  if (isNonblankString(input.id) && Array.from(existingSessionIds).includes(input.id)) {
    error('duplicate_id', 'id', 'Session ID is already in use.');
  }
  if (errors.length) return { ok: false, errors };
  const value = input as unknown as CreateSessionInput;
  return {
    ok: true,
    value: {
      id: value.id,
      taskId: value.taskId,
      createdAt: value.createdAt,
      roleExecutionSnapshot,
      executionAttemptId: value.executionAttemptId ?? null,
      sdkSessionId: value.sdkSessionId ?? null,
    },
  };
}

export function createSession(
  taskState: unknown,
  input: unknown,
  existingSessionIds: Iterable<string> = [],
): SessionContractResult<Session> {
  const result = validateCreateSession(taskState, input, existingSessionIds);
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      ...result.value,
      state: 'Ready',
      waitingContext: null,
      updatedAt: result.value.createdAt,
      startedAt: null,
      endedAt: null,
      roleExecutionSnapshot: result.value.roleExecutionSnapshot ?? null,
      executionAttemptId: result.value.executionAttemptId ?? null,
      sdkSessionId: result.value.sdkSessionId ?? null,
    },
  };
}

export function createTaskSessionAssociation(taskId: unknown): SessionContractResult<TaskSessionAssociation> {
  if (!isNonblankString(taskId)) return sessionError('blank', 'taskId', 'Task ID must be a nonblank string.');
  return { ok: true, value: { taskId, currentSessionId: null, recentResult: null } };
}

/** Transition a full Session and maintain deterministic timestamps without mutating the input. */
export function transitionSession(
  session: Session,
  to: unknown,
  at: unknown,
  options: { waitingContext?: unknown } = {},
): SessionContractResult<Session> {
  if (!isTimestamp(at) || at < session.updatedAt) return sessionError('invalid_transition', 'at', 'Transition timestamp must be a nondecreasing integer.');
  const result = getSessionStateTransition(session.state, to);
  if (!result.ok) {
    const code = result.error.code === 'terminal_state_immutable' ? 'terminal_state_immutable' : 'invalid_transition';
    return sessionError(code, 'state', result.error.message);
  }
  const currentWaitingContext = session.waitingContext ?? null;
  let nextWaitingContext: WaitingContext | null = null;
  if (session.state === 'Waiting') {
    const current = validateWaitingContext(currentWaitingContext);
    if (!current.ok || current.value.startedAt > session.updatedAt) {
      return sessionError('invalid_waiting_context', 'waitingContext', 'A Waiting Session must have a valid context no later than its last update.');
    }
  }
  if (result.state === 'Waiting') {
    if (options.waitingContext === undefined) {
      if (session.state !== 'Waiting') return sessionError('required_waiting_context', 'waitingContext', 'Entering Waiting requires a valid Waiting context.');
      nextWaitingContext = currentWaitingContext;
    } else {
      const waiting = validateWaitingContext(options.waitingContext);
      if (!waiting.ok) return sessionError('invalid_waiting_context', `waitingContext.${waiting.errors[0]?.path ?? ''}`.replace(/\.$/, ''), waiting.errors[0]?.message ?? 'Invalid Waiting context.');
      if (waiting.value.startedAt > at) return sessionError('invalid_waiting_context', 'waitingContext.startedAt', 'Waiting start time cannot be later than the transition.');
      nextWaitingContext = waiting.value;
    }
  } else if (options.waitingContext !== undefined) {
    return sessionError('forbidden_waiting_context', 'waitingContext', 'Waiting context is only valid when the target state is Waiting.');
  }
  if (result.transition.action === 'noop') {
    return {
      ok: true,
      value: {
        ...session,
        waitingContext: nextWaitingContext,
        updatedAt: result.state === 'Waiting' && options.waitingContext !== undefined ? at : session.updatedAt,
      },
    };
  }
  const terminal = result.state === 'Completed' || result.state === 'Failed';
  return {
    ok: true,
    value: {
      ...session,
      state: result.state,
      waitingContext: nextWaitingContext,
      updatedAt: at,
      startedAt: result.state === 'Running' ? session.startedAt ?? at : session.startedAt,
      endedAt: terminal ? at : null,
    },
  };
}

export function createSessionResult(session: Session, input: unknown): SessionContractResult<SessionRecentResult> {
  if (!isRoleObject(input)) return sessionError('invalid_type', '', 'Expected a Session result object.');
  const value = input as unknown as SessionResultInput;
  const errors: SessionContractError[] = [];
  for (const key of Object.keys(input)) {
    if (!['outcome', 'completedAt', 'summary', 'error'].includes(key)) {
      errors.push({ code: 'invalid_result', path: key, message: 'Unknown Session result field.' });
    }
  }
  if (session.state !== 'Completed' && session.state !== 'Failed') {
    errors.push({ code: 'invalid_result', path: 'session.state', message: 'Only a terminal Session can have a result.' });
  }
  if (!Object.hasOwn(value, 'outcome')) errors.push({ code: 'invalid_result', path: 'outcome', message: 'Result outcome is required.' });
  else if (value.outcome !== 'success' && value.outcome !== 'failure') errors.push({ code: 'invalid_result', path: 'outcome', message: 'Outcome must be success or failure.' });
  if ((session.state === 'Completed' && value.outcome !== 'success') || (session.state === 'Failed' && value.outcome !== 'failure')) {
    errors.push({ code: 'invalid_result', path: 'outcome', message: 'Result outcome must match the terminal Session state.' });
  }
  if (!Object.hasOwn(value, 'completedAt') || !isTimestamp(value.completedAt)) errors.push({ code: 'invalid_result', path: 'completedAt', message: 'Completed timestamp must be a nonnegative integer.' });
  if (Object.hasOwn(value, 'summary') && value.summary !== null && typeof value.summary !== 'string') errors.push({ code: 'invalid_result', path: 'summary', message: 'Summary must be a string or null.' });
  if (Object.hasOwn(value, 'error') && value.error !== null && typeof value.error !== 'string') errors.push({ code: 'invalid_result', path: 'error', message: 'Error must be a string or null.' });
  if (value.outcome === 'failure' && !isNonblankString(value.error)) errors.push({ code: 'invalid_result', path: 'error', message: 'Failure results require a nonblank error.' });
  if (value.outcome === 'success' && value.error !== undefined && value.error !== null && value.error.trim()) errors.push({ code: 'invalid_result', path: 'error', message: 'Success results cannot contain an error.' });
  if (isTimestamp(value.completedAt) && session.endedAt !== null && value.completedAt < session.endedAt) errors.push({ code: 'invalid_result', path: 'completedAt', message: 'Result timestamp cannot precede Session termination.' });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      sessionId: session.id,
      outcome: value.outcome,
      completedAt: value.completedAt,
      summary: value.summary?.trim() || null,
      error: value.error?.trim() || null,
    },
  };
}

/** Admit one Ready Session as the Task's sole current Session; terminal Sessions may be retried by replacement. */
export function attachSessionToTask(
  association: TaskSessionAssociation,
  session: Session,
  currentSession: Session | null = null,
): SessionContractResult<TaskSessionAssociation> {
  if (association.taskId !== session.taskId) return sessionError('task_mismatch', 'taskId', 'Session belongs to a different Task.');
  if (session.state !== 'Ready') return sessionError('invalid_transition', 'session.state', 'Only a Ready Session can become current.');
  if (association.currentSessionId !== null && currentSession === null) return sessionError('concurrent_session', 'currentSessionId', 'The existing current Session must be supplied before replacement.');
  if (currentSession !== null) {
    if (currentSession.id !== association.currentSessionId || currentSession.taskId !== association.taskId) return sessionError('task_mismatch', 'currentSession', 'Current Session does not match the Task association.');
    if (currentSession.state !== 'Completed' && currentSession.state !== 'Failed') return sessionError('concurrent_session', 'currentSession', 'A Task may have only one nonterminal current Session.');
  }
  return { ok: true, value: { ...association, currentSessionId: session.id } };
}

/** Record only the current Session's terminal result; late or duplicate results cannot overwrite it. */
export function recordSessionResult(
  association: TaskSessionAssociation,
  session: Session,
  input: unknown,
): SessionContractResult<TaskSessionAssociation> {
  if (association.taskId !== session.taskId || association.currentSessionId !== session.id) return sessionError('stale_session_result', 'sessionId', 'Result belongs to a Session that is no longer current.');
  if (association.recentResult?.sessionId === session.id) return sessionError('result_already_recorded', 'sessionId', 'A terminal result is already recorded for this Session.');
  const result = createSessionResult(session, input);
  if (!result.ok) return result;
  return { ok: true, value: { ...association, recentResult: result.value } };
}

function handoffError(code: HandoffContractError['code'], path: string, message: string): HandoffContractResult<never> {
  return { ok: false, errors: [{ code, path, message }] };
}

function isOpaqueId(value: unknown): value is string {
  return isNonblankString(value) && value === value.trim();
}

const VALID_HANDOFF_SESSION_REFERENCE_REASONS: readonly HandoffSessionReferenceReason[] = ['session_not_created', 'not_applicable'] as const;

function isValidHandoffSessionReferenceReason(value: unknown): value is HandoffSessionReferenceReason {
  return typeof value === 'string' && (VALID_HANDOFF_SESSION_REFERENCE_REASONS as readonly string[]).includes(value);
}

/** Create an empty append head for one resolved Task/Card pair. */
export function createTaskHandoffAssociation(owner: HandoffOwner): HandoffContractResult<TaskHandoffAssociation> {
  if (!isRoleObject(owner)) return handoffError('invalid_type', '', 'Expected a Task/Card owner object.');
  if (!isOpaqueId(owner.taskId)) return handoffError('blank', 'taskId', 'Task ID must be a nonblank opaque identifier.');
  if (!isOpaqueId(owner.cardId)) return handoffError('blank', 'cardId', 'Card ID must be a nonblank opaque identifier.');
  return { ok: true, value: { taskId: owner.taskId, cardId: owner.cardId, latestHandoffId: null } };
}

/** Validate and materialize one immutable Handoff reference; storage still owns uniqueness and atomicity. */
export function createHandoff(
  owner: HandoffOwner,
  input: unknown,
  roleIds: Iterable<string>,
  relatedSession: Session | null = null,
): HandoffContractResult<Handoff> {
  if (!isRoleObject(owner) || !isOpaqueId(owner.taskId) || !isOpaqueId(owner.cardId)) {
    return handoffError('invalid_type', 'owner', 'Expected a resolved Task and corresponding Card identity.');
  }
  if (!isRoleObject(input)) return handoffError('invalid_type', '', 'Expected a Handoff input object.');
  const known = ['id', 'taskId', 'cardId', 'sourceRoleId', 'targetRoleId', 'sessionId', 'sessionReferenceReason', 'createdAt', 'previousHandoffId'];
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) return handoffError('unknown_field', key, 'Field is not part of the minimum Handoff reference.');
  }
  for (const key of ['id', 'taskId', 'cardId', 'sourceRoleId', 'targetRoleId']) {
    if (!Object.hasOwn(input, key)) return handoffError('required', key, 'Field is required.');
    if (!isOpaqueId(input[key])) return handoffError('blank', key, 'Expected a nonblank opaque identifier without surrounding whitespace.');
  }
  if (!Object.hasOwn(input, 'createdAt')) return handoffError('required', 'createdAt', 'Creation timestamp is required.');
  if (!isTimestamp(input.createdAt)) return handoffError('invalid_timestamp', 'createdAt', 'Expected a nonnegative integer timestamp.');
  if (input.taskId !== owner.taskId) return handoffError('task_mismatch', 'taskId', 'Handoff Task does not match the resolved owner.');
  if (input.cardId !== owner.cardId) return handoffError('card_mismatch', 'cardId', 'Handoff Card does not correspond to the resolved Task owner.');
  const availableRoles = new Set(roleIds);
  for (const key of ['sourceRoleId', 'targetRoleId']) {
    if (!availableRoles.has(input[key] as string)) return handoffError('invalid_role_reference', key, 'Role reference is unavailable.');
  }

  if (Object.hasOwn(input, 'sessionId') && input.sessionId === undefined) return handoffError('invalid_type', 'sessionId', 'Session ID must be null or a nonblank opaque identifier.');
  const sessionId = input.sessionId === undefined ? null : input.sessionId;
  if (sessionId !== null && !isOpaqueId(sessionId)) return handoffError('blank', 'sessionId', 'Session ID must be null or a nonblank opaque identifier.');
  if (Object.hasOwn(input, 'sessionReferenceReason') && input.sessionReferenceReason === undefined) {
    return handoffError('invalid_type', 'sessionReferenceReason', 'Reference reason must be null or a supported reason.');
  }
  const reason = input.sessionReferenceReason === undefined ? null : input.sessionReferenceReason;
  if (sessionId === null) {
    if (reason === null) {
      return handoffError('session_reference_reason_required', 'sessionReferenceReason', 'A null Session reference requires an explicit reason.');
    }
    if (!isValidHandoffSessionReferenceReason(reason)) return handoffError('invalid_type', 'sessionReferenceReason', 'Expected a supported null-reference reason.');
  } else {
    if (reason !== null) {
      if (!isValidHandoffSessionReferenceReason(reason)) return handoffError('invalid_type', 'sessionReferenceReason', 'Expected a supported null-reference reason or null.');
      return handoffError('unexpected_session_reference_reason', 'sessionReferenceReason', 'A present Session reference cannot carry a null-reference reason.');
    }
    if (!relatedSession || relatedSession.id !== sessionId || relatedSession.taskId !== owner.taskId) {
      return handoffError('invalid_session_reference', 'sessionId', 'Session must exist and belong to the same Task as the Handoff.');
    }
  }

  const previousHandoffId = input.previousHandoffId === undefined ? null : input.previousHandoffId;
  if (Object.hasOwn(input, 'previousHandoffId') && input.previousHandoffId === undefined) {
    return handoffError('invalid_type', 'previousHandoffId', 'Previous Handoff ID must be null or a nonblank opaque identifier.');
  }
  if (previousHandoffId !== null && !isOpaqueId(previousHandoffId)) {
    return handoffError('blank', 'previousHandoffId', 'Previous Handoff ID must be null or a nonblank opaque identifier.');
  }
  return {
    ok: true,
    value: Object.freeze({
      id: input.id as string,
      taskId: input.taskId as string,
      cardId: input.cardId as string,
      sourceRoleId: input.sourceRoleId as string,
      targetRoleId: input.targetRoleId as string,
      sessionId,
      sessionReferenceReason: reason as HandoffSessionReferenceReason | null,
      createdAt: input.createdAt,
      previousHandoffId,
    }),
  };
}

/** Append by advancing only the Task/Card head; stale or cross-owner writers cannot overwrite it. */
export function appendHandoff(
  association: TaskHandoffAssociation,
  owner: HandoffOwner,
  handoff: Handoff,
  expectedLatestHandoffId: string | null,
  knownHandoffIds: Iterable<string> = [],
): HandoffContractResult<TaskHandoffAssociation> {
  if (association.taskId !== owner.taskId || handoff.taskId !== owner.taskId) {
    return handoffError('task_mismatch', 'taskId', 'Association and Handoff must belong to the resolved Task.');
  }
  if (association.cardId !== owner.cardId || handoff.cardId !== owner.cardId) {
    return handoffError('card_mismatch', 'cardId', 'Association and Handoff must belong to the corresponding Card.');
  }
  if (new Set(knownHandoffIds).has(handoff.id) || association.latestHandoffId === handoff.id) {
    return handoffError('duplicate_handoff', 'id', 'Handoff ID has already been appended.');
  }
  if (association.latestHandoffId !== expectedLatestHandoffId || handoff.previousHandoffId !== expectedLatestHandoffId) {
    return handoffError('stale_handoff_head', 'previousHandoffId', 'Handoff append was based on a stale or mismatched current head.');
  }
  return { ok: true, value: { ...association, latestHandoffId: handoff.id } };
}

/** Allowed column transitions. Key = current column, value = columns you can move to. */
export const VALID_TRANSITIONS: Record<ColumnId, readonly ColumnId[]> = {
  'backlog': ['in-progress'],
  'in-progress': ['backlog', 'review'],
  'review': ['done', 'in-progress'],
  'done': ['in-progress'],
};

export function isValidPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (VALID_PRIORITIES as readonly string[]).includes(value);
}

export function isValidColumnId(value: unknown): value is ColumnId {
  return typeof value === 'string' && (VALID_COLUMNS as readonly string[]).includes(value);
}

export function isValidBoardStageId(value: unknown): value is BoardStageId {
  return typeof value === 'string' && (BOARD_STAGE_ORDER as readonly string[]).includes(value);
}

/** Explicit one-time adapter for legacy rows. Unknown values remain unmapped and retain column_id. */
export function mapLegacyColumnToBoard(columnId: unknown): { boardStage: BoardStageId; lifecycleState: TaskLifecycleState } | null {
  switch (columnId) {
    case 'backlog': return { boardStage: 'draft', lifecycleState: 'Draft' };
    case 'in-progress': return { boardStage: 'implement', lifecycleState: 'Active' };
    case 'review': return { boardStage: 'review', lifecycleState: 'Active' };
    // Legacy Done is treated as a historical Human-confirmed completion.
    case 'done': return { boardStage: 'knowledge', lifecycleState: 'Done' };
    default: return null;
  }
}

export function isValidAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === 'string' && (VALID_AGENT_STATUSES as readonly string[]).includes(value);
}

export function isValidAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && (VALID_AGENT_TYPES as readonly string[]).includes(value);
}

export function isValidThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === 'string' && (VALID_THINKING_EFFORTS as readonly string[]).includes(value);
}

export function isBuiltInRoleId(value: unknown): value is RoleId {
  return typeof value === 'string' && (BUILT_IN_ROLE_IDS as readonly string[]).includes(value);
}

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 5000;
export const MIN_AGENT_TIMEOUT_MINUTES = 1;
export const MAX_AGENT_TIMEOUT_MINUTES = 240;
export const MAX_GROUP_CHILDREN = 20;
export const MIN_GROUP_CHILDREN = 2;

export function isValidAgentTimeoutMinutes(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_AGENT_TIMEOUT_MINUTES
    && value <= MAX_AGENT_TIMEOUT_MINUTES;
}

export function isValidMaxConcurrency(value: unknown, childCount: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= childCount;
}

function isRoleObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateRoleInput(input: unknown, partial: boolean): RoleContractError[] {
  const errors: RoleContractError[] = [];
  const error = (path: string, code: RoleContractError['code'], message: string) => {
    errors.push({ path, code, message });
  };
  if (!isRoleObject(input)) {
    error('', 'invalid_type', 'Expected a role input object.');
    return errors;
  }
  const knownFields = ['name', 'responsibility', 'instructions', 'execution'];
  for (const key of Object.keys(input)) {
    if (!knownFields.includes(key)) error(key, 'unknown_field', 'Field is not writable.');
  }
  for (const key of ['name', 'responsibility', 'instructions']) {
    if (!Object.hasOwn(input, key)) {
      if (!partial) error(key, 'required', 'Field is required.');
    } else if (typeof input[key] !== 'string') {
      error(key, 'invalid_type', 'Expected a string.');
    } else if (!(input[key] as string).trim()) {
      error(key, 'blank', 'Field must not be blank.');
    }
  }
  if (!Object.hasOwn(input, 'execution')) {
    if (!partial) error('execution', 'required', 'Execution configuration is required.');
    return errors;
  }
  const execution = input.execution;
  if (!isRoleObject(execution)) {
    error('execution', 'invalid_type', 'Expected an execution configuration object.');
    return errors;
  }
  for (const key of Object.keys(execution)) {
    if (key !== 'provider' && key !== 'model') {
      error(`execution.${key}`, 'unknown_field', 'Field is not writable.');
    }
  }
  if (!Object.hasOwn(execution, 'provider')) {
    if (!partial) error('execution.provider', 'required', 'Provider is required.');
  } else if (!isValidAgentType(execution.provider)) {
    error('execution.provider', 'unknown_provider', 'Expected a supported provider identifier.');
  }
  if (Object.hasOwn(execution, 'model') && execution.model !== null) {
    if (typeof execution.model !== 'string') {
      error('execution.model', 'invalid_type', 'Expected a model string or null.');
    } else if (!execution.model.trim()) {
      error('execution.model', 'blank', 'Model must not be blank.');
    }
  }
  return errors;
}

/** Strict new-contract validation; does not change legacy API validation. */
export function validateCreateRole(input: unknown): RoleContractResult<CreateRoleInput> {
  const errors = validateRoleInput(input, false);
  if (errors.length) return { ok: false, errors };
  const value = input as CreateRoleInput;
  return {
    ok: true,
    value: {
      name: value.name.trim(),
      responsibility: value.responsibility,
      instructions: value.instructions,
      execution: { provider: value.execution.provider, model: value.execution.model?.trim() ?? null },
    },
  };
}

/** Omitted fields are preserved. Explicit undefined is invalid, as is null except for model. */
export function validateUpdateRole(input: unknown): RoleContractResult<UpdateRoleInput> {
  const errors = validateRoleInput(input, true);
  if (errors.length) return { ok: false, errors };
  const value = input as UpdateRoleInput;
  const patch: UpdateRoleInput = {};
  if (Object.hasOwn(value, 'name')) patch.name = value.name!.trim();
  if (Object.hasOwn(value, 'responsibility')) patch.responsibility = value.responsibility;
  if (Object.hasOwn(value, 'instructions')) patch.instructions = value.instructions;
  if (Object.hasOwn(value, 'execution')) {
    patch.execution = {};
    if (Object.hasOwn(value.execution!, 'provider')) patch.execution.provider = value.execution!.provider;
    if (Object.hasOwn(value.execution!, 'model')) patch.execution.model = value.execution!.model?.trim() ?? null;
  }
  return { ok: true, value: patch };
}

/** Identity allocation/uniqueness belongs to the future storage boundary. */
export function createRole(id: string, input: unknown): RoleContractResult<Role> {
  if (typeof id !== 'string' || !id.trim() || id !== id.trim()) {
    return { ok: false, errors: [{ path: 'id', code: 'invalid_type', message: 'Expected a nonblank opaque identifier without surrounding whitespace.' }] };
  }
  const result = validateCreateRole(input);
  if (!result.ok) return result;
  return {
    ok: true,
    value: { ...result.value, id, execution: { ...result.value.execution, model: result.value.execution.model ?? null } },
  };
}

/** Apply a validated partial edit to an existing valid Role without mutating it. */
export function updateRole(role: Role, input: unknown): RoleContractResult<Role> {
  const result = validateUpdateRole(input);
  if (!result.ok) return result;
  const patch = result.value;
  const provider = patch.execution?.provider ?? role.execution.provider;
  // A model choice cannot silently cross provider boundaries.
  const model = patch.execution && Object.hasOwn(patch.execution, 'model')
    ? patch.execution.model ?? null
    : provider === role.execution.provider ? role.execution.model : null;
  return { ok: true, value: { ...role, ...patch, execution: { ...role.execution, provider, model } } };
}

/** Capture before execution; later Role edits cannot rewrite this selection. */
export function snapshotRoleExecution(role: Role): RoleExecutionSnapshot {
  return Object.freeze({
    roleId: role.id,
    name: role.name,
    responsibility: role.responsibility,
    instructions: role.instructions,
    execution: Object.freeze({ provider: role.execution.provider, model: role.execution.model }),
  });
}
