import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';
import { BUILTIN_COMMANDS } from '../packages/repl/src/interactive/commands.js';
import { createInteractiveContext } from '../packages/repl/src/interactive/context.js';
import type { CommandCallbacks, CurrentConfig } from '../packages/repl/src/commands/types.js';
import { ArgumentCompleter } from '../packages/repl/src/interactive/completers/argument-completer.js';

class CatalogProvider extends KodaXBaseProvider {
  readonly name = 'product-catalog-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_CATALOG_TEST_KEY', model: 'catalog-test', supportsThinking: false,
  };
  async stream(): Promise<KodaXStreamResult> {
    return { textBlocks: [{ type: 'text', text: 'ok' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  }
}

let homeDir: string;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let first: Awaited<ReturnType<typeof connectKodaXClient>>;
let second: Awaited<ReturnType<typeof connectKodaXClient>>;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-catalog-'));
  registerModelProvider('product-catalog-test', () => new CatalogProvider());
  vi.stubEnv('KODAX_PRODUCT_CATALOG_TEST_KEY', 'test-only');
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-catalog-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire the catalog Host.');
  const endpointPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\kodax-catalog-' + randomUUID()
    : path.join(homeDir, 'host.sock');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: endpointPath }
    : { kind: 'unix' as const, path: endpointPath };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  first = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  second = await connectKodaXClient({ homeDir, endpoint: endpointPath });
});

afterEach(async () => {
  await Promise.allSettled([first?.disconnect(), second?.disconnect()]);
  await host?.close();
  await runtime.close();
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 30_000);

it('lists real Host skills, commands, and effective config through typed queries', async () => {
  // Skills come from the Host's real registry: built-in Skills ship with the
  // product, so both clients see the same non-empty typed inventory.
  const skills = await first.catalog.skills();
  expect(skills.length).toBeGreaterThan(0);
  // The registry resolves from real installed locations (user overrides may
  // shadow the built-in), so the typed shape is pinned, not the origin.
  const review = skills.find((skill) => skill.name === 'code-review');
  expect(review).toBeDefined();
  expect(review!.source.length).toBeGreaterThan(0);
  expect(typeof review!.description).toBe('string');
  expect(review!.description.length).toBeGreaterThan(0);
  expect(review!.path.length).toBeGreaterThan(0);
  expect((await second.catalog.skills()).map((skill) => skill.name))
    .toEqual(skills.map((skill) => skill.name));
  const userInvocable = await first.catalog.skills({ userInvocableOnly: true });
  const invocableNames = new Set(userInvocable.map((skill) => skill.name));
  for (const name of invocableNames) {
    expect(skills.some((skill) => skill.name === name)).toBe(true);
  }

  // Commands come from the Host's real command registry for the workspace.
  const commands = await first.catalog.commands(homeDir);
  expect(commands.length).toBeGreaterThan(0);
  expect(commands.find((command) => command.name === 'help')).toMatchObject({ aliases: ['h', '?'] });
  for (const command of commands) {
    expect(typeof command.name).toBe('string');
    expect(typeof command.description).toBe('string');
    expect(typeof command.source).toBe('string');
  }

  // Config-effective: a saved default is readable by both clients and a real
  // reload confirms the same effective state.
  const config = await first.config.read();
  const reloaded = await second.config.reload();
  expect(reloaded).toMatchObject({ ok: true });
  expect(reloaded.config).toEqual(config);

  // A patch through one client must reach the other client after reload:
  // the saved-defaults file is Host-owned state, not per-connection cache.
  const desiredVerifierLog = !(config.verifierLog ?? false);
  const patched = await first.config.patch({ verifierLog: desiredVerifierLog });
  expect(patched.verifierLog).toBe(desiredVerifierLog);
  const observed = await second.config.reload();
  expect(observed).toMatchObject({ ok: true });
  expect(observed.config.verifierLog).toBe(desiredVerifierLog);
  expect((await second.config.read()).verifierLog).toBe(desiredVerifierLog);

  await first.config.patch({ model: 'explicit-model', effort: 'high' });
  // JSON needs an explicit reset value; omission must keep unrelated defaults.
  await first.config.patch({ model: null, effort: null });
  const cleared = (await second.config.reload()).config;
  expect(cleared.model).toBeUndefined();
  expect(cleared.effort).toBeUndefined();
  expect(cleared.verifierLog).toBe(desiredVerifierLog);
}, 60_000);

it('selects a Host-only model through the actual model command and clears it when switching provider', async () => {
  await first.config.patch({ providerModels: { 'openai': ['host-only'] } });
  const session = await first.sessions.create({ projectPath: homeDir });
  const current: CurrentConfig = {
    provider: 'openai', thinking: false, reasoningMode: 'off',
    agentMode: 'sa', permissionMode: 'full-access',
  };
  const callbacks: CommandCallbacks = {
    config: first.config, catalog: first.catalog,
    exit() {}, async saveSession() {},
    async loadSession() { return 'missing'; }, async listSessions() {}, clearHistory() {}, printHistory() {},
    ui: {
      async select() { throw new Error('Unexpected selection'); },
      async confirm() { throw new Error('Unexpected confirmation'); },
      async input() { throw new Error('Unexpected input'); },
    },
    async switchProvider(provider, model) {
      await first.sessions.updateSettings(session.id, { provider, model: model ?? null });
    },
    async setEffort(effort) {
      await first.sessions.updateSettings(session.id, { effort: effort ?? null });
    },
    async setReasoningMode(reasoningMode) {
      await first.sessions.updateSettings(session.id, { reasoningMode, thinking: reasoningMode !== 'off' });
    },
    async setAgentMode(agentMode) {
      await first.sessions.updateSettings(session.id, { agentMode });
    },
    async setRepoIntelligenceRuntime(update) {
      await first.sessions.updateSettings(session.id, {
        ...(update.mode !== undefined ? { repoIntelligenceMode: update.mode } : {}),
        ...(update.trace !== undefined ? { repoIntelligenceTrace: update.trace } : {}),
      });
    },
  };
  const command = BUILTIN_COMMANDS.find(item => item.name === 'model')!;
  const context = await createInteractiveContext({});
  const result = await command.handler(['/host-only'], context, callbacks, current);
  expect(result).toEqual({ success: true, message: '[Model: openai/host-only] Host default saved; Session applied' });
  expect(await second.config.read()).toMatchObject({ model: 'host-only' });
  expect(await second.sessions.getSettings(session.id)).toMatchObject({ model: 'host-only' });
  expect(await command.handler(['openai'], context, callbacks, current)).toMatchObject({ success: true });
  expect((await second.config.read()).model).toBeUndefined();
  expect((await second.sessions.getSettings(session.id)).model).toBeUndefined();
  await first.config.patch({ effort: 'high' });
  await first.sessions.updateSettings(session.id, { effort: 'high' });
  const effortCommand = BUILTIN_COMMANDS.find(item => item.name === 'effort')!;
  expect(await effortCommand.handler(['auto'], context, callbacks, current)).toMatchObject({ success: true });
  expect((await second.config.read()).effort).toBeUndefined();
  expect(await second.sessions.getSettings(session.id)).toMatchObject({ reasoningMode: 'auto', thinking: true });
  expect((await second.sessions.getSettings(session.id)).effort).toBeUndefined();
  const modeCommand = BUILTIN_COMMANDS.find(item => item.name === 'agent-mode')!;
  expect(await modeCommand.handler(['ama'], context, callbacks, current)).toMatchObject({ success: true });
  expect(await second.config.read()).toMatchObject({ agentMode: 'ama' });
  expect(await second.sessions.getSettings(session.id)).toMatchObject({ agentMode: 'ama' });
  const repoCommand = BUILTIN_COMMANDS.find(item => item.name === 'repo-intel')!;
  expect(await repoCommand.handler(['mode', 'off'], context, callbacks, current)).toMatchObject({ success: true });
  expect(await second.config.read()).toMatchObject({ repoIntelligenceMode: 'off' });
  expect(await second.sessions.getSettings(session.id)).toMatchObject({ repoIntelligenceMode: 'off' });
  const completer = new ArgumentCompleter(() => ({ catalog: first.catalog, selection: () => current }));
  expect(await completer.getCompletions('/model openai/host', 18)).toContainEqual({
    text: 'openai/host-only', display: 'openai/host-only', description: 'host-only', type: 'argument',
  });
  await first.config.patch({ planModeEffort: 'high' });
  await first.sessions.updateSettings(session.id, { permissionMode: 'plan', effort: null });
  let effectiveEffort: string | undefined;
  const observation = await second.sessions.observe(session.id, view => { effectiveEffort = view.settings.effort; });
  try { await expect.poll(() => effectiveEffort).toBe('high'); }
  finally { observation.close(); }
  const other = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(other.id, { agentMode: 'ama' });
  const patch = runtime.config.patch;
  runtime.config.patch = async () => { throw new Error('Injected Host save failure'); };
  try {
    expect(await modeCommand.handler(['sa'], context, callbacks, current)).toMatchObject({
      success: false, message: expect.stringMatching(/Host default save failed:.*Session applied/),
    });
    expect(await second.sessions.getSettings(session.id)).toMatchObject({ agentMode: 'sa' });
    expect(await second.config.read()).toMatchObject({ agentMode: 'ama' });
  } finally { runtime.config.patch = patch; }
  await first.sessions.delete(session.id);
  expect(await modeCommand.handler(['sa'], context, callbacks, current)).toMatchObject({
    success: false, message: expect.stringMatching(/Host default saved; Session apply failed:/),
  });
  expect(await second.config.read()).toMatchObject({ agentMode: 'sa' });
  expect(await second.sessions.getSettings(other.id)).toMatchObject({ agentMode: 'ama' });
});
