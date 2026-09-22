import type { ColumnId, Priority, AgentStatus, AgentType, RoleId, ThinkingEffort } from './types.js';

export const VALID_PRIORITIES: readonly Priority[] = ['low', 'medium', 'high', 'critical'] as const;
export const VALID_COLUMNS: readonly ColumnId[] = ['backlog', 'in-progress', 'review', 'done'] as const;
export const VALID_AGENT_STATUSES: readonly AgentStatus[] = ['idle', 'planning', 'executing', 'complete', 'failed'] as const;
export const VALID_AGENT_TYPES: readonly AgentType[] = ['copilot', 'claude', 'codex', 'opencode', 'hermes', 'openclaw', 'grok'] as const;
export const VALID_THINKING_EFFORTS: readonly ThinkingEffort[] = ['low', 'medium', 'high'] as const;
export const BUILT_IN_ROLE_IDS: readonly RoleId[] = ['orchestrator', 'research', 'implementor', 'reviewer', 'knowledge'] as const;

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
