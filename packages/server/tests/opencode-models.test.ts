import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ProviderConfig } from '../src/types.js';
import { discoverOpenCodeModels } from '../src/services/opencode-models.js';

function fixture(t: TestContext, script: string, extraArgs: string[] = []): ProviderConfig {
  const directory = mkdtempSync(path.join(tmpdir(), 'opencode-models-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'fake-opencode.cjs');
  writeFileSync(filename, script);
  return {
    id: 'opencode', displayName: 'OpenCode', enabled: true,
    cliCommand: process.execPath, commandArgs: [filename, ...extraArgs], models: [], capabilities: [],
  };
}

test('OpenCode uses the configured executable and arguments and parses the complete catalog', async t => {
  const provider = fixture(t, `
    require('node:assert/strict').deepEqual(process.argv.slice(2), ['--custom', 'value with spaces', 'models']);
    console.log('Loading models...');
    console.log('\\x1b[32mopencode/big-pickle\\x1b[0m');
    console.log('github-copilot/gpt-5');
    console.log('anthropic/claude-sonnet-4-5');
    console.log('github-copilot/gpt-5');
    console.log('not a/model');
    console.error('Startup diagnostics');
  `, ['--custom', 'value with spaces']);
  provider.defaultModel = 'github-copilot/gpt-5';
  assert.deepEqual(await discoverOpenCodeModels(provider), {
    models: ['opencode/big-pickle', 'github-copilot/gpt-5', 'anthropic/claude-sonnet-4-5'],
    defaultModel: 'github-copilot/gpt-5',
  });
});

test('OpenCode excludes a configured default absent from the live catalog', async t => {
  const provider = fixture(t, "console.log('opencode/big-pickle')");
  provider.defaultModel = 'removed/model';
  assert.equal((await discoverOpenCodeModels(provider)).defaultModel, undefined);
});

test('OpenCode reports an empty catalog rather than accepting diagnostic output', async t => {
  const provider = fixture(t, "console.log('Loading models...\\nNo providers available')");
  const result = await discoverOpenCodeModels(provider);
  assert.deepEqual(result.models, []);
  assert.match(result.reason!, /returned no models/);
});

test('OpenCode discards partial output when the command fails', async t => {
  const provider = fixture(t, "console.log('opencode/partial'); process.exitCode = 2;");
  const result = await discoverOpenCodeModels(provider);
  assert.deepEqual(result.models, []);
  assert.match(result.reason!, /Unable to query OpenCode.*2/);
});

test('OpenCode reports a missing configured executable', async t => {
  const provider = fixture(t, '');
  provider.cliCommand = path.join(path.dirname(provider.commandArgs[0]), 'missing');
  const result = await discoverOpenCodeModels(provider);
  assert.deepEqual(result.models, []);
  assert.match(result.reason!, /ENOENT/);
});

test('OpenCode bounds catalog output', async t => {
  const provider = fixture(t, "process.stdout.write('x'.repeat(5 * 1024 * 1024))");
  const result = await discoverOpenCodeModels(provider);
  assert.deepEqual(result.models, []);
  assert.match(result.reason!, /exceeded the output limit/);
});

test('OpenCode terminates a stalled catalog command', { timeout: 15_000 }, async t => {
  const provider = fixture(t, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
  const start = Date.now();
  const result = await discoverOpenCodeModels(provider);
  assert.deepEqual(result.models, []);
  assert.match(result.reason!, /timed out/);
  assert.ok(Date.now() - start < 14_000);
});
