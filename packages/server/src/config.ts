import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentType, ProjectConfig, ProviderConfig, RoleConfig, SettingsConfig } from './types.js';
import { errorMessage } from './utils.js';

/**
 * Agent Board persists its server-side configuration in a JSON file at a fixed
 * location (the "Agent Board home"). The clone root — where repos cloned from a
 * URL are placed — is configurable and defaults to `<home>/projects`.
 *
 * The config file deliberately lives at a fixed path (NOT inside the configurable
 * clone root) to avoid a chicken-and-egg problem: we must be able to read the
 * config before we know where the clone root is.
 */

const CONFIG_FILE_NAME = 'config.json';

function expandTilde(p: string): string {
  if (!p.startsWith('~')) return p;
  const rest = p.slice(p.startsWith('~/') || p.startsWith('~\\') ? 2 : 1);
  return path.join(os.homedir(), rest);
}

export function getConfigHome(): string {
  const override = process.env.AGENTBOARD_HOME?.trim();
  return override ? path.resolve(expandTilde(override)) : path.join(os.homedir(), 'agentboard');
}

function getConfigPath(): string {
  return path.join(getConfigHome(), CONFIG_FILE_NAME);
}

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: 'copilot', displayName: 'GitHub Copilot CLI', enabled: true, cliCommand: 'copilot', commandArgs: [], models: ['claude-opus-4-20250514'], capabilities: ['cli', 'coding'] },
  { id: 'claude', displayName: 'Claude Code', enabled: true, cliCommand: 'claude', commandArgs: [], models: ['claude-opus-4-20250514'], capabilities: ['cli', 'coding'] },
  { id: 'codex', displayName: 'Codex CLI', enabled: true, cliCommand: 'codex', commandArgs: [], models: ['gpt-5.2-codex'], capabilities: ['cli', 'coding', 'reasoning'] },
  { id: 'opencode', displayName: 'OpenCode', enabled: true, cliCommand: 'opencode', commandArgs: [], models: [], capabilities: ['cli', 'coding'] },
  { id: 'hermes', displayName: 'Hermes', enabled: true, cliCommand: process.env.HERMES_COMMAND?.trim() || 'hermes', commandArgs: ['--acp'], models: [], capabilities: ['cli', 'coding'] },
  { id: 'openclaw', displayName: 'OpenClaw', enabled: true, cliCommand: process.env.OPENCLAW_COMMAND?.trim() || 'openclaw', commandArgs: ['acp'], models: [], capabilities: ['cli', 'coding'] },
  { id: 'grok', displayName: 'Grok', enabled: true, cliCommand: 'grok', commandArgs: [], models: [], capabilities: ['cli', 'coding'] },
];

const DEFAULT_ROLES: RoleConfig[] = [
  { id: 'orchestrator', displayName: 'Orchestrator', binding: { providerId: 'codex', model: 'gpt-5.2-codex', thinking: 'high' }, instructions: 'Coordinate workflow, validate handoffs, and keep execution context reproducible.' },
  { id: 'research', displayName: 'Research', binding: { providerId: 'codex', model: 'gpt-5.2-codex', thinking: 'medium' }, instructions: 'Investigate the task, collect evidence, and report actionable findings.' },
  { id: 'implementor', displayName: 'Implementor', binding: { providerId: 'codex', model: 'gpt-5.2-codex', thinking: 'medium' }, instructions: 'Implement the smallest safe change and validate it locally.' },
  { id: 'reviewer', displayName: 'Reviewer', binding: { providerId: 'copilot', model: 'claude-opus-4-20250514', thinking: 'high' }, instructions: 'Review correctness, regressions, and test evidence before handoff.' },
  { id: 'knowledge', displayName: 'Knowledge', binding: { providerId: 'codex', model: 'gpt-5.2-codex', thinking: 'low' }, instructions: 'Capture durable, concise knowledge from completed work.' },
];

function cloneProviders(): ProviderConfig[] {
  return DEFAULT_PROVIDERS.map(provider => ({ ...provider, commandArgs: [...provider.commandArgs], models: [...provider.models], capabilities: [...provider.capabilities] }));
}

function cloneRoles(): RoleConfig[] {
  return DEFAULT_ROLES.map(role => ({ ...role, binding: { ...role.binding } }));
}

function defaultConfig(): SettingsConfig {
  return { cloneRoot: path.join(getConfigHome(), 'projects'), providers: cloneProviders(), roles: cloneRoles() };
}

let cached: SettingsConfig | null = null;

function configuredProviders(raw: unknown): ProviderConfig[] {
  if (!Array.isArray(raw)) return cloneProviders();
  const defaults = new Map(DEFAULT_PROVIDERS.map(provider => [provider.id, provider]));
  const parsed = raw.flatMap((item): ProviderConfig[] => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Partial<ProviderConfig>;
    const base = typeof candidate.id === 'string' ? defaults.get(candidate.id as AgentType) : undefined;
    if (!base || typeof candidate.displayName !== 'string' || typeof candidate.cliCommand !== 'string'
      || typeof candidate.enabled !== 'boolean' || !Array.isArray(candidate.commandArgs)
      || !Array.isArray(candidate.models) || !Array.isArray(candidate.capabilities)) return [];
    if (![...candidate.commandArgs, ...candidate.models, ...candidate.capabilities].every(value => typeof value === 'string')) return [];
    return [{
      id: base.id,
      displayName: candidate.displayName,
      enabled: candidate.enabled,
      cliCommand: candidate.cliCommand,
      commandArgs: [...candidate.commandArgs],
      models: [...candidate.models],
      capabilities: [...candidate.capabilities],
    }];
  });
  return parsed.length === DEFAULT_PROVIDERS.length ? parsed : cloneProviders();
}

function configuredRoles(raw: unknown): RoleConfig[] {
  if (!Array.isArray(raw)) return cloneRoles();
  const defaults = new Map(DEFAULT_ROLES.map(role => [role.id, role]));
  const parsed = raw.flatMap((item): RoleConfig[] => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Partial<RoleConfig>;
    const base = typeof candidate.id === 'string' ? defaults.get(candidate.id as RoleConfig['id']) : undefined;
    const binding = candidate.binding;
    if (!base || typeof candidate.displayName !== 'string' || typeof candidate.instructions !== 'string'
      || !binding || typeof binding !== 'object' || typeof binding.providerId !== 'string'
      || typeof binding.model !== 'string' || (binding.thinking !== 'low' && binding.thinking !== 'medium' && binding.thinking !== 'high')) return [];
    return [{
      id: base.id,
      displayName: candidate.displayName,
      instructions: candidate.instructions,
      binding: { providerId: binding.providerId as AgentType, model: binding.model, thinking: binding.thinking },
    }];
  });
  return parsed.length === DEFAULT_ROLES.length ? parsed : cloneRoles();
}

/** Atomically write the config file (temp file + rename) to avoid corruption. */
function writeConfig(config: SettingsConfig): void {
  const home = getConfigHome();
  fs.mkdirSync(home, { recursive: true });
  const target = getConfigPath();
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, target);
}

/**
 * Load (and if necessary create) the Agent Board config. Ensures the home
 * directory, the config file, and the clone root directory all exist.
 */
export function loadConfig(): SettingsConfig {
  if (cached) return cached;

  const home = getConfigHome();
  fs.mkdirSync(home, { recursive: true });

  const configPath = getConfigPath();
  let config = defaultConfig();
  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<SettingsConfig>;
      if (raw && typeof raw.cloneRoot === 'string' && raw.cloneRoot.trim()) {
        config = {
          cloneRoot: path.resolve(expandTilde(raw.cloneRoot.trim())),
          providers: configuredProviders(raw.providers),
          roles: configuredRoles(raw.roles),
        };
      } else {
        writeConfig(config);
      }
    } catch (err) {
      console.warn(`[config] failed to read ${configPath}, using defaults: ${errorMessage(err)}`);
      writeConfig(config);
    }
  } else {
    writeConfig(config);
  }

  fs.mkdirSync(config.cloneRoot, { recursive: true });
  cached = config;
  return config;
}

export function getConfig(): SettingsConfig {
  return cached ?? loadConfig();
}

export function getCloneRoot(): string {
  return getConfig().cloneRoot;
}

/**
 * Update the clone root. The new path is expanded/resolved, created on disk, and
 * persisted to the config file. Returns the updated config.
 */
export function setCloneRoot(cloneRoot: string): ProjectConfig {
  const trimmed = cloneRoot.trim();
  if (!trimmed) throw new Error('cloneRoot must be a non-empty string');
  const resolved = path.resolve(expandTilde(trimmed));
  if (!path.isAbsolute(resolved)) throw new Error('cloneRoot must be an absolute path');
  fs.mkdirSync(resolved, { recursive: true });
  const next: SettingsConfig = { ...getConfig(), cloneRoot: resolved };
  writeConfig(next);
  cached = next;
  return next;
}

export function setSettings(settings: SettingsConfig): SettingsConfig {
  const cloneRoot = settings.cloneRoot.trim();
  if (!cloneRoot) throw new Error('cloneRoot must be a non-empty string');
  const next: SettingsConfig = { ...settings, cloneRoot: path.resolve(expandTilde(cloneRoot)) };
  fs.mkdirSync(next.cloneRoot, { recursive: true });
  writeConfig(next);
  cached = next;
  return next;
}
