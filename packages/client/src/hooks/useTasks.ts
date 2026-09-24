import { useState, useCallback, useEffect } from 'react';
import type { Task, AgentType, BoardStageId } from '@/types';
import { BOARD_STAGE_TRANSITIONS } from '@/types';
import { api, connectWS } from '@/lib/api';

const getProjectId = (task: Task) => task.projectId ?? 'default';

export function useTasks(projectId = 'default') {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Fetch tasks on mount and when showArchived changes
  useEffect(() => {
    api.getTasks(showArchived, projectId).then(setTasks).catch((err) => {
      setError(`Failed to load tasks: ${err.message}`);
    });
  }, [showArchived, projectId]);

  // WebSocket: live task updates from server, re-sync on reconnect
  useEffect(() => {
    return connectWS(
      (msg) => {
        if (msg.type === 'task_updated') {
          const task = msg.payload;
          if (getProjectId(task) !== projectId) return;
          // Skip grouped children — they're managed by useTaskGroups
          if (task.groupId) return;
          setTasks((prev) => {
            const exists = prev.some((t) => t.id === task.id);
            if (exists) return prev.map((t) => (t.id === task.id ? task : t));
            return [...prev, task];
          });
        }
        if (msg.type === 'task_deleted') {
          setTasks((prev) => prev.filter((t) => t.id !== msg.payload.id));
        }
      },
      // Re-fetch all tasks after WS reconnect to catch missed updates
      () => { api.getTasks(showArchived, projectId).then(setTasks).catch(console.error); }
    );
  }, [showArchived, projectId]);

  const addTask = useCallback(async (task: Omit<Task, 'id' | 'createdAt' | 'agentStatus'> & { autoRun?: boolean }) => {
    try {
      const newTask = await api.createTask({ ...task, projectId: task.projectId ?? projectId });
      // Deduplicate: WS broadcast may have already added this task
      setTasks((prev) =>
        prev.some((t) => t.id === newTask.id) ? prev : [...prev, newTask]
      );
      return newTask;
    } catch (err) {
      setError(`Failed to create task: ${(err as Error).message}`);
      return undefined;
    }
  }, [projectId]);

  const runTask = useCallback(async (id: string) => {
    try {
      const updated = await api.runTask(id);
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      return updated;
    } catch (err) {
      setError(`Failed to start agent: ${(err as Error).message}`);
      return undefined;
    }
  }, []);

  const moveTask = useCallback(async (taskId: string, targetStage: BoardStageId) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task?.boardStage || !BOARD_STAGE_TRANSITIONS[task.boardStage]?.includes(targetStage)) return;
    try {
      const updated = await api.moveCard(taskId, targetStage);
      setTasks((prev) => prev.map((item) => (item.id === taskId ? updated : item)));
    } catch (err) {
      const error = err as Error;
      setError(`Move failed: ${error.message}`);
      try {
        setTasks(await api.getTasks(showArchived, projectId));
      } catch (fetchErr) {
        setError(`Move failed and could not refresh: ${(fetchErr as Error).message}`);
      }
    }
  }, [tasks, showArchived, projectId]);

  const completeTask = useCallback(async (id: string) => {
    try {
      const updated = await api.completeTask(id);
      setTasks((prev) => prev.map((item) => (item.id === id ? updated : item)));
      return updated;
    } catch (err) {
      setError(`Failed to complete task: ${(err as Error).message}`);
      return undefined;
    }
  }, []);

  const configureAndRunTask = useCallback(async (
    id: string,
    config: { repoPath: string; branchName: string; baseBranch: string; useWorktree: boolean; agentType?: AgentType }
  ) => {
    try {
      const configured = await api.configureTask(id, config);
      setTasks((prev) => prev.map((t) => (t.id === id ? configured : t)));
      const updated = await api.runTask(id);
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch (err) {
      setError(`Failed to start agent: ${(err as Error).message}`);
    }
  }, []);

  const createPR = useCallback(async (id: string) => {
    try {
      const result = await api.createPR(id);
      return result.url;
    } catch (err) {
      setError(`Failed to create PR: ${(err as Error).message}`);
      return undefined;
    }
  }, []);

  const cleanupWorktree = useCallback(async (id: string) => {
    try {
      await api.cleanupWorktree(id);
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, worktreePath: undefined } : t)));
    } catch (err) {
      setError(`Failed to clean up worktree: ${(err as Error).message}`);
    }
  }, []);

  const mergeLocal = useCallback(async (id: string) => {
    try {
      const result = await api.mergeLocal(id);
      return result.baseBranch;
    } catch (err) {
      setError(`Failed to merge locally: ${(err as Error).message}`);
      return undefined;
    }
  }, []);

  const stopTask = useCallback(async (id: string) => {
    try {
      const updated = await api.stopTask(id);
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch (err) {
      setError(`Failed to stop agent: ${(err as Error).message}`);
    }
  }, []);

  const updateTask = useCallback(async (id: string, updates: Partial<Task>) => {
    try {
      const updated = await api.updateTask(id, updates);
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      return updated;
    } catch (err) {
      setError(`Failed to update task: ${(err as Error).message}`);
      return undefined;
    }
  }, []);

  const deleteTask = useCallback(async (id: string) => {
    try {
      await api.deleteTask(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setError(`Failed to delete task: ${(err as Error).message}`);
    }
  }, []);

  const archiveTask = useCallback(async (id: string) => {
    try {
      const updated = await api.archiveTask(id);
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch (err) {
      setError(`Failed to archive task: ${(err as Error).message}`);
    }
  }, []);

  const unarchiveTask = useCallback(async (id: string) => {
    try {
      const updated = await api.unarchiveTask(id);
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch (err) {
      setError(`Failed to unarchive task: ${(err as Error).message}`);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { tasks, error, clearError, showArchived, setShowArchived, addTask, updateTask, moveTask, completeTask, runTask, stopTask, deleteTask, archiveTask, unarchiveTask, configureAndRunTask, createPR, mergeLocal, cleanupWorktree };
}
