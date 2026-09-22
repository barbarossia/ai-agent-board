import { Router, type Request, type Response } from 'express';
import type { AgentManager } from '../services/agent-manager.js';
import type { ProviderConfig, RoleBindingOverride, RoleConfig, SettingsConfig, SettingsResponse } from '../types.js';
import { getConfig, setSettings } from '../config.js';
import { parseSettingsConfig, resolveRoleExecution } from '../services/settings-validation.js';
import { isBuiltInRoleId, isValidAgentType } from '@ai-agent-board/shared/constants.js';

function settingsResponse(agentManager: AgentManager): SettingsResponse {
  const settings = getConfig();
  const availability = new Map(agentManager.getAvailableAgents().map(agent => [agent.name, agent]));
  return {
    ...settings,
    providerValidation: settings.providers.map((provider) => {
      const agent = availability.get(provider.id);
      return {
        ...provider,
        available: Boolean(agent?.available) && provider.enabled,
        version: agent?.version,
        reason: !provider.enabled ? 'Disabled in Settings' : agent?.reason,
      };
    }),
  };
}

function replaceProvider(settings: SettingsConfig, provider: ProviderConfig): SettingsConfig {
  return { ...settings, providers: settings.providers.map(item => item.id === provider.id ? provider : item) };
}

function replaceRole(settings: SettingsConfig, role: RoleConfig): SettingsConfig {
  return { ...settings, roles: settings.roles.map(item => item.id === role.id ? role : item) };
}

export function createSettingsRouter(agentManager: AgentManager): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => res.json(settingsResponse(agentManager)));

  router.put('/providers/:id', (req: Request, res: Response) => {
    if (!isValidAgentType(req.params.id)) {
      res.status(400).json({ error: 'unknown provider id' }); return;
    }
    const candidate = { ...req.body, id: req.params.id } as ProviderConfig;
    const parsed = parseSettingsConfig(replaceProvider(getConfig(), candidate));
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed }); return;
    }
    setSettings(parsed);
    res.json(settingsResponse(agentManager));
  });

  router.put('/roles/:id', (req: Request, res: Response) => {
    if (!isBuiltInRoleId(req.params.id)) {
      res.status(400).json({ error: 'unknown role id' }); return;
    }
    const candidate = { ...req.body, id: req.params.id } as RoleConfig;
    const parsed = parseSettingsConfig(replaceRole(getConfig(), candidate));
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed }); return;
    }
    setSettings(parsed);
    res.json(settingsResponse(agentManager));
  });

  router.post('/roles/:id/resolve', (req: Request, res: Response) => {
    if (!isBuiltInRoleId(req.params.id)) {
      res.status(400).json({ error: 'unknown role id' }); return;
    }
    const snapshot = resolveRoleExecution(getConfig(), req.params.id, (req.body ?? {}) as RoleBindingOverride);
    if (typeof snapshot === 'string') {
      res.status(400).json({ error: snapshot }); return;
    }
    res.json(snapshot);
  });

  return router;
}
