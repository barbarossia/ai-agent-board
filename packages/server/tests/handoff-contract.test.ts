import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendHandoff,
  createHandoff,
  createSession,
  createTaskHandoffAssociation,
} from '@ai-agent-board/shared/constants.js';
import type { Handoff, HandoffContractResult, HandoffOwner } from '@ai-agent-board/shared/types.js';

const ownerA: HandoffOwner = { taskId: 'task-a', cardId: 'card-a' };
const ownerB: HandoffOwner = { taskId: 'task-b', cardId: 'card-b' };
const roles = ['role-builder', 'role-reviewer'];

function input(id: string, owner: HandoffOwner, overrides: Record<string, unknown> = {}) {
  return {
    id,
    taskId: owner.taskId,
    cardId: owner.cardId,
    sourceRoleId: 'role-builder',
    targetRoleId: 'role-reviewer',
    sessionId: null,
    sessionReferenceReason: 'session_not_created',
    createdAt: 100,
    previousHandoffId: null,
    ...overrides,
  };
}

function value<T>(result: HandoffContractResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('Expected success');
  return result.value;
}

function rejects(result: HandoffContractResult<unknown>, code: string, path?: string) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected validation failure');
  assert.ok(result.errors.some(error => error.code === code && (path === undefined || error.path === path)), JSON.stringify(result.errors));
}

function handoff(id: string, owner = ownerA, previousHandoffId: string | null = null): Handoff {
  return value(createHandoff(owner, input(id, owner, { previousHandoffId }), roles));
}

test('Handoff references a Task and its corresponding Card with Role, optional Session and creation identity', () => {
  const created = handoff('handoff-1');
  assert.deepEqual(created, {
    id: 'handoff-1', taskId: 'task-a', cardId: 'card-a', sourceRoleId: 'role-builder', targetRoleId: 'role-reviewer',
    sessionId: null, sessionReferenceReason: 'session_not_created', createdAt: 100, previousHandoffId: null,
  });
  assert.equal(Object.isFrozen(created), true);
  assert.deepEqual(JSON.parse(JSON.stringify(created)), created);
  rejects(createHandoff(ownerA, input('wrong-task', ownerA, { taskId: 'task-b' }), roles), 'task_mismatch', 'taskId');
  rejects(createHandoff(ownerA, input('wrong-card', ownerA, { cardId: 'card-b' }), roles), 'card_mismatch', 'cardId');
  rejects(createHandoff(ownerA, input('missing-role', ownerA, { targetRoleId: 'deleted-role' }), roles), 'invalid_role_reference', 'targetRoleId');
  const missingTimestamp = input('missing-time', ownerA) as Record<string, unknown>;
  delete missingTimestamp.createdAt;
  rejects(createHandoff(ownerA, missingTimestamp, roles), 'required', 'createdAt');
  rejects(createHandoff(ownerA, input('undefined-session', ownerA, { sessionId: undefined }), roles), 'invalid_type', 'sessionId');
});

test('nullable Session references require a reason and present Sessions must share the Handoff Task', () => {
  rejects(createHandoff(ownerA, input('missing-reason', ownerA, { sessionReferenceReason: null }), roles), 'session_reference_reason_required', 'sessionReferenceReason');
  rejects(createHandoff(ownerA, input('unexpected-reason', ownerA, {
    sessionId: 'session-a', sessionReferenceReason: 'not_applicable',
  }), roles), 'unexpected_session_reference_reason', 'sessionReferenceReason');
  rejects(createHandoff(ownerA, input('missing-session', ownerA, {
    sessionId: 'session-a', sessionReferenceReason: null,
  }), roles), 'invalid_session_reference', 'sessionId');

  const sessionA = value(createSession('Active', { id: 'session-a', taskId: 'task-a', createdAt: 50 }));
  const sessionB = value(createSession('Active', { id: 'session-b', taskId: 'task-b', createdAt: 50 }));
  assert.equal(createHandoff(ownerA, input('with-session', ownerA, {
    sessionId: 'session-a', sessionReferenceReason: null,
  }), roles, sessionA).ok, true);
  rejects(createHandoff(ownerA, input('cross-session', ownerA, {
    sessionId: 'session-b', sessionReferenceReason: null,
  }), roles, sessionB), 'invalid_session_reference', 'sessionId');
});

test('append updates are Task/Card scoped, append-only and isolated across Tasks and Sessions', () => {
  const associationA = value(createTaskHandoffAssociation(ownerA));
  const associationB = value(createTaskHandoffAssociation(ownerB));
  const sessionA1 = value(createSession('Active', { id: 'session-a1', taskId: 'task-a', createdAt: 90 }));
  const sessionA2 = value(createSession('Active', { id: 'session-a2', taskId: 'task-a', createdAt: 110 }));
  const sessionB1 = value(createSession('Active', { id: 'session-b1', taskId: 'task-b', createdAt: 90 }));
  const first = value(createHandoff(ownerA, input('handoff-a1', ownerA, {
    sessionId: 'session-a1', sessionReferenceReason: null,
  }), roles, sessionA1));
  const second = value(createHandoff(ownerA, input('handoff-a2', ownerA, {
    sessionId: 'session-a2', sessionReferenceReason: null, previousHandoffId: 'handoff-a1',
  }), roles, sessionA2));
  const otherTask = value(createHandoff(ownerB, input('handoff-b1', ownerB, {
    sessionId: 'session-b1', sessionReferenceReason: null,
  }), roles, sessionB1));
  const appended = value(appendHandoff(associationA, ownerA, first, null));
  assert.equal(appended.latestHandoffId, 'handoff-a1');
  const appendedAgain = value(appendHandoff(appended, ownerA, second, 'handoff-a1', ['handoff-a1']));
  assert.equal(appendedAgain.latestHandoffId, 'handoff-a2');
  const otherTaskAppended = value(appendHandoff(associationB, ownerB, otherTask, null));
  assert.equal(otherTaskAppended.latestHandoffId, 'handoff-b1');
  assert.equal(associationA.latestHandoffId, null);
  assert.equal(associationB.latestHandoffId, null);
  rejects(appendHandoff(appended, ownerA, second, null), 'stale_handoff_head', 'previousHandoffId');
  rejects(appendHandoff(associationB, ownerB, first, null), 'task_mismatch', 'taskId');
  assert.equal(first.sessionId, sessionA1.id);
  assert.equal(second.sessionId, sessionA2.id);
  assert.equal(appendedAgain.latestHandoffId, 'handoff-a2');
  assert.equal(otherTaskAppended.latestHandoffId, 'handoff-b1');
});
