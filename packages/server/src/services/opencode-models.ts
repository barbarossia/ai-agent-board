import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import type { ProviderConfig } from '../types.js';
import type { ProviderModelsResult } from './provider-models.js';

const execFileAsync = promisify(execFile);

/** Query the configured CLI directly, without starting a server on a shared port. */
export async function discoverOpenCodeModels(provider: ProviderConfig): Promise<ProviderModelsResult> {
  try {
    const { stdout } = await execFileAsync(provider.cliCommand, [...provider.commandArgs, 'models'], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    const models = [...new Set(stripVTControlCharacters(stdout)
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(line)))];
    if (!models.length) return { models: [], reason: 'OpenCode returned no models in its model catalog' };
    return {
      models,
      defaultModel: provider.defaultModel && models.includes(provider.defaultModel) ? provider.defaultModel : undefined,
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    const reason = failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      ? 'OpenCode model catalog exceeded the output limit'
      : failure.killed
        ? 'OpenCode model catalog timed out'
        : `Unable to query ${provider.displayName} model catalog (${failure.code ?? 'command failed'})`;
    return { models: [], reason };
  }
}
