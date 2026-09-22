import type {
  ColumnId, Priority, AgentStatus, AgentType, CreateRoleInput, UpdateRoleInput,
  Role, RoleContractError, RoleContractResult, RoleExecutionSnapshot,
} from './types.js';

export const VALID_PRIORITIES: readonly Priority[] = ['low', 'medium', 'high', 'critical'] as const;
export const VALID_COLUMNS: readonly ColumnId[] = ['backlog', 'in-progress', 'review', 'done'] as const;
export const VALID_AGENT_STATUSES: readonly AgentStatus[] = ['idle', 'planning', 'executing', 'complete', 'failed'] as const;
export const VALID_AGENT_TYPES: readonly AgentType[] = ['copilot', 'claude', 'codex', 'opencode', 'hermes', 'openclaw', 'grok'] as const;

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

export function isValidAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === 'string' && (VALID_AGENT_STATUSES as readonly string[]).includes(value);
}

export function isValidAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && (VALID_AGENT_TYPES as readonly string[]).includes(value);
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
