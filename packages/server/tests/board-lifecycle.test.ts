import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { createHandoff, mapLegacyColumnToBoard } from '@ai-agent-board/shared/constants.js';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { createTaskRouter } from '../src/routes/tasks.js';
import type { Project, Task } from '../src/types.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';
import type { AgentManager } from '../src/services/agent-manager.js';

const task = (id: string, columnId: Task['columnId'], boardStage: Task['boardStage'], lifecycleState: Task['lifecycleState']): Task => ({
  id, projectId: 'default', title: id, description: '', priority: 'medium', columnId, boardStage, lifecycleState,
  agentStatus: 'idle', agentType: 'copilot', createdAt: 1,
});

test('legacy column mapping is explicit and leaves unknown values unmapped', () => {
  assert.deepEqual(mapLegacyColumnToBoard('backlog'), { boardStage: 'draft', lifecycleState: 'Draft' });
  assert.deepEqual(mapLegacyColumnToBoard('in-progress'), { boardStage: 'implement', lifecycleState: 'Active' });
  assert.deepEqual(mapLegacyColumnToBoard('review'), { boardStage: 'review', lifecycleState: 'Active' });
  assert.deepEqual(mapLegacyColumnToBoard('done'), { boardStage: 'knowledge', lifecycleState: 'Done' });
  assert.equal(mapLegacyColumnToBoard('unexpected'), null);
});

test('SQLite migration preserves unknown legacy column values for recovery', async () => {
  const db = new Database(':memory:');
  try {
    migrateSqliteDatabase(db);
    db.prepare(`INSERT INTO tasks (id, project_id, title, description, priority, column_id, agent_status, agent_type, created_at)
      VALUES ('unknown', 'default', 'Unknown', '', 'medium', 'legacy-stage', 'idle', 'copilot', 1)`).run();
    migrateSqliteDatabase(db);
    const row = db.prepare('SELECT column_id, board_stage, lifecycle_state FROM tasks WHERE id = ?').get('unknown') as Record<string, unknown>;
    assert.equal(row.column_id, 'legacy-stage');
    assert.equal(row.board_stage, null);
    assert.equal(row.lifecycle_state, null);
    const recovered = await new SqliteTaskRepository(db).getById('unknown');
    assert.equal(recovered?.legacyColumnId, 'legacy-stage');
    assert.equal(recovered?.boardStage, null);
    assert.equal(recovered?.lifecycleState, null);
  } finally {
    db.close();
  }
});

test('SQLite Board transition appends an immutable Handoff and stage audit atomically', async () => {
  const db = new Database(':memory:');
  try {
    migrateSqliteDatabase(db);
    const repo = new SqliteTaskRepository(db);
    await repo.create(task('card-1', 'backlog', 'draft', 'Draft'));
    const created = createHandoff({ taskId: 'card-1', cardId: 'card-1' }, {
      id: 'handoff-1', taskId: 'card-1', cardId: 'card-1', sourceRoleId: 'human', targetRoleId: 'orchestrator',
      sessionId: null, sessionReferenceReason: 'session_not_created', createdAt: 2, previousHandoffId: null,
    }, ['human', 'orchestrator']);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const updated = await repo.transitionBoardCard('card-1', 'draft', {
      boardStage: 'inbox', lifecycleState: 'Active', agentStatus: 'planning', startedAt: 2,
    }, created.value, 'inbox', 'human');
    assert.equal(updated?.boardStage, 'inbox');
    assert.equal(updated?.lifecycleState, 'Active');
    assert.equal(updated?.columnId, 'backlog');
    assert.equal(updated?.handoff?.latestHandoffId, 'handoff-1');

    const history = await repo.getHandoffs('card-1');
    assert.equal(history.length, 1);
    assert.equal(history[0].handoff.id, 'handoff-1');
    assert.equal(history[0].targetStage, 'inbox');
    assert.equal(history[0].actorId, 'human');
    assert.equal(await repo.transitionBoardCard('card-1', 'draft', { boardStage: 'research' }, created.value, 'research', 'human'), undefined);
    assert.equal((await repo.getHandoffs('card-1')).length, 1);
  } finally {
    db.close();
  }
});

test('Board API rejects invalid stage commands and requires explicit Knowledge completion', async () => {
  const db = new Database(':memory:');
  try {
    migrateSqliteDatabase(db);
    const repo = new SqliteTaskRepository(db);
    await repo.create(task('draft-card', 'backlog', 'draft', 'Draft'));
    await repo.create(task('knowledge-card', 'review', 'knowledge', 'Active'));
    const project: Project = { id: 'default', name: 'Default', aliases: [], isDefault: true, createdAt: 1, updatedAt: 1 };
    const projects = {
      getById: async (id: string) => id === project.id ? project : undefined,
      getDefault: async () => project,
      resolve: async () => [],
    } as unknown as ProjectRepository;
    const agents = {
      getAvailableAgents: () => [],
      isRunning: () => false,
      startAgent: () => undefined,
    } as unknown as AgentManager;
    const app = express();
    app.use(express.json());
    app.use('/api/tasks', createTaskRouter(repo, agents, projects));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api/tasks`;
    try {
      const invalidMove = await fetch(`${base}/draft-card/board-stage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetStage: 'research' }),
      });
      assert.equal(invalidMove.status, 400);
      assert.equal((await repo.getById('draft-card'))?.boardStage, 'draft');
      assert.equal((await repo.getHandoffs('draft-card')).length, 0);

      const unconfirmed = await fetch(`${base}/knowledge-card/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      assert.equal(unconfirmed.status, 409);
      assert.equal((await repo.getById('knowledge-card'))?.lifecycleState, 'Active');

      const confirmed = await fetch(`${base}/knowledge-card/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completionConfirmed: true }),
      });
      assert.equal(confirmed.status, 200);
      assert.equal((await confirmed.json() as Task).lifecycleState, 'Done');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  } finally {
    db.close();
  }
});
