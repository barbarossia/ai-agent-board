import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import { discoverOpenCodeModels } from './opencode-models.js';
import type { ProviderConfig } from '../types.js';

export interface ProviderModelsResult {
  models: string[];
  defaultModel?: string;
  reason?: string;
}

const MODEL_CACHE_TTL_MS = 60_000;
const cache = new Map<string, { key: string; expiresAt: number; result: ProviderModelsResult }>();

function cacheKey(provider: ProviderConfig): string {
  return JSON.stringify([provider.cliCommand, provider.commandArgs, provider.defaultModel]);
}

function cached(provider: ProviderConfig): ProviderModelsResult | undefined {
  const entry = cache.get(provider.id);
  return entry && entry.key === cacheKey(provider) && entry.expiresAt > Date.now() ? entry.result : undefined;
}

function resolveCliPath(command: string): string {
  if (path.isAbsolute(command)) return command;
  try {
    const resolver = process.platform === 'win32' ? 'where.exe' : 'which';
    const resolved = execFileSync(resolver, [command], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean);
    return resolved || command;
  } catch {
    return command;
  }
}

function discoverCodexModels(provider: ProviderConfig): Promise<ProviderModelsResult> {
  return new Promise(resolve => {
    const child = spawn(provider.cliCommand, [...provider.commandArgs, 'app-server'], {
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    const finish = (result: ProviderModelsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolve(result);
    };
    const timeout = setTimeout(() => finish({ models: [], reason: 'Codex model catalog timed out' }), 10_000);
    const output = readline.createInterface({ input: child.stdout });
    output.on('line', line => {
      try {
        const message = JSON.parse(line) as {
          id?: number;
          result?: { data?: Array<{ id?: string; model?: string; isDefault?: boolean; hidden?: boolean }> };
          error?: { message?: string };
        };
        if (message.id !== 2) return;
        const models = (message.result?.data ?? [])
          .filter(item => !item.hidden)
          .map(item => item.id ?? item.model)
          .filter((item): item is string => Boolean(item?.trim()));
        const defaultEntry = (message.result?.data ?? []).find(item => item.isDefault && !item.hidden);
        finish({ models: [...new Set(models)], defaultModel: defaultEntry?.id ?? defaultEntry?.model });
      } catch {
        // Ignore non-JSON startup noise from a provider CLI.
      }
    });
    child.once('error', error => finish({ models: [], reason: `Unable to query ${provider.displayName}: ${error.message}` }));
    child.once('close', code => {
      if (!settled) finish({ models: [], reason: `Codex model catalog exited with code ${code ?? 'unknown'}` });
    });
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'agent-board', title: 'Agent Board', version: '0.1.0' } } });
    send({ method: 'initialized', params: {} });
    send({ method: 'model/list', id: 2, params: { limit: 100, includeHidden: false } });
  });
}

async function discoverCopilotModels(provider: ProviderConfig): Promise<ProviderModelsResult> {
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: resolveCliPath(provider.cliCommand), args: provider.commandArgs }),
    logLevel: 'none',
  });
  try {
    await client.start();
    const models = await client.listModels();
    const visible = models.map(model => model.id).filter(Boolean);
    return {
      models: [...new Set(visible)],
      reason: visible.length === 0
        ? 'Copilot returned no models. Check your Copilot CLI login and model access.'
        : visible.every(id => id === 'auto')
          ? 'Copilot returned only Auto for the current login. Check your Copilot CLI account and model access if you expected more models.'
          : undefined,
    };
  } catch (error) {
    return { models: [], reason: `Unable to query ${provider.displayName}: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    // Model discovery has no sessions to clean up. Force-stop the short-lived
    // stdio client so the SDK does not write to its destroyed JSON-RPC stream
    // while the child process is being terminated.
    await client.forceStop().catch(() => undefined);
  }
}

/** Discover models from the provider when its CLI exposes a model catalog. */
export async function listProviderModels(provider: ProviderConfig): Promise<ProviderModelsResult> {
  const hit = cached(provider);
  if (hit) return hit;
  const result = provider.id === 'codex'
    ? await discoverCodexModels(provider)
    : provider.id === 'copilot'
      ? await discoverCopilotModels(provider)
      : provider.id === 'opencode'
        ? await discoverOpenCodeModels(provider)
        : { models: [], reason: `${provider.displayName} does not expose a model catalog` };
  if (result.models.length > 0 && !result.reason) {
    cache.set(provider.id, { key: cacheKey(provider), expiresAt: Date.now() + MODEL_CACHE_TTL_MS, result });
  }
  return result;
}
