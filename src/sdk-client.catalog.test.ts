import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, KodaXProviderError, clearRuntimeModelProviders, registerModelProvider,
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
import { awaitLatestCodingMemoryReviewDrain, LEARNING_REVIEW_TOOL } from '@kodax-ai/coding';
import { createCliSessionCommands } from './cli-client-plane.js';
import { resolveOneShotSession } from './one-shot-task.js';
import { listCliResumeSessions } from '../packages/repl/src/cli-resume.js';
import { resolveBareResume } from './kodax_resume.js';

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
  await startCatalogHost();
});

async function startCatalogHost(): Promise<void> {
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
}

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
  runtime.config.patch = async input => { await patch(input); throw new Error('Injected post-save failure'); };
  try {
    expect(await modeCommand.handler(['sa'], context, callbacks, current)).toMatchObject({
      success: true, message: expect.stringMatching(/Host default saved.*confirmed.*Session applied/),
    });
    expect(await second.config.read()).toMatchObject({ agentMode: 'sa' });
  } finally { runtime.config.patch = patch; }
  await first.sessions.delete(session.id);
  expect(await modeCommand.handler(['sa'], context, callbacks, current)).toMatchObject({
    success: false, message: expect.stringMatching(/Host default saved; Session apply failed:/),
  });
  expect(await second.config.read()).toMatchObject({ agentMode: 'sa' });
  expect(await second.sessions.getSettings(other.id)).toMatchObject({ agentMode: 'ama' });
});

it('applies explicit execution controls and exposes only their safe effective facts across clients', async () => {
  vi.stubEnv('KODAX_VERIFIER_LOG', '0');
  vi.stubEnv('KODAX_STALL_LOG', '0');
  vi.stubEnv('KODAX_FALLBACK_PROVIDERS', 'old-shell-provider');
  await first.config.patch({ verifierLog: true, stallLog: true, fallbackProviders: ['product-catalog-test'] });
  expect(await second.config.readEffective()).toEqual({
    verifierLog: { value: true, source: 'persisted', applied: true },
    stallLog: { value: true, source: 'persisted', applied: true },
    fallbackProviders: { value: ['product-catalog-test'], source: 'persisted', applied: true },
  });
  await first.config.reload();
  expect((await second.config.readEffective()).verifierLog.value).toBe(true);
  process.env.KODAX_VERIFIER_LOG = '0';
  await first.config.reload();
  expect((await second.config.readEffective()).verifierLog).toEqual({ value: false, source: 'environment', applied: true });
  await first.config.patch({ verifierLog: false, stallLog: false, fallbackProviders: null });
  expect((await second.config.readEffective()).fallbackProviders).toEqual({ value: [], source: 'unset', applied: true });
  expect((await second.config.readEffective()).verifierLog.value).toBe(false);
  expect((await second.config.read()).fallbackProviders).toBeUndefined();
  const callbacks: CommandCallbacks = {
    config: first.config, exit() {}, async saveSession() {},
    async loadSession() { return 'missing'; }, async listSessions() {}, clearHistory() {}, printHistory() {},
    ui: {
      async select() { throw new Error('Unexpected selection'); },
      async confirm() { throw new Error('Unexpected confirmation'); },
      async input() { throw new Error('Unexpected input'); },
    },
  };
  const context = await createInteractiveContext({});
  const current: CurrentConfig = { provider: 'product-catalog-test', thinking: false, reasoningMode: 'off', agentMode: 'sa', permissionMode: 'full-access' };
  for (const [name, field] of [['verifier-log', 'verifierLog'], ['stall-log', 'stallLog']] as const) {
    const command = BUILTIN_COMMANDS.find(item => item.name === name)!;
    expect(await command.handler(['on'], context, callbacks, current)).toMatchObject({ success: true });
    expect((await second.config.readEffective())[field].value).toBe(true);
    expect(await command.handler(['off'], context, callbacks, current)).toMatchObject({ success: true });
    expect((await second.config.readEffective())[field].value).toBe(false);
  }
  const fallback = BUILTIN_COMMANDS.find(item => item.name === 'fallback')!;
  expect(await fallback.handler(['product-catalog-test'], context, callbacks, current)).toMatchObject({ success: true });
  expect((await second.config.readEffective()).fallbackProviders.value).toEqual(['product-catalog-test']);
  expect(await fallback.handler(['off'], context, callbacks, current)).toMatchObject({ success: true });
  expect((await second.config.readEffective()).fallbackProviders.value).toEqual([]);
  const patch = runtime.config.patch;
  runtime.config.patch = async () => { throw new Error('Controlled save failure'); };
  try {
    expect(await fallback.handler(['product-catalog-test'], context, callbacks, current)).toMatchObject({
      success: false, message: expect.stringMatching(/Host default save failed:.*\nHost desired value not applied/),
    });
  } finally { runtime.config.patch = patch; }
  runtime.config.patch = async input => { await patch(input); throw new Error('Controlled post-save failure'); };
  try {
    expect(await fallback.handler(['product-catalog-test'], context, callbacks, current)).toMatchObject({
      success: true, message: expect.stringMatching(/Host default saved\nHost applied\nUpdate reported an error:/),
    });
  } finally { runtime.config.patch = patch; }
  const effective = runtime.config.readEffective;
  runtime.config.readEffective = async () => { throw new Error('Controlled effective query failure'); };
  try {
    expect(await fallback.handler(['product-catalog-test'], context, callbacks, current)).toMatchObject({
      success: false, message: expect.stringContaining('Host default saved; Effective state unavailable:'),
    });
    expect((await second.config.read()).fallbackProviders).toEqual(['product-catalog-test']);
  } finally { runtime.config.readEffective = effective; }
  await Promise.all([first.disconnect(), second.disconnect()]);
  await host.close();
  await runtime.close();
  vi.stubEnv('KODAX_VERIFIER_LOG', '1');
  await startCatalogHost();
  expect((await first.config.read()).verifierLog).toBe(false);
  expect((await second.config.readEffective()).verifierLog).toEqual({ value: true, source: 'environment', applied: true });
});

it('uses saved log controls during the next actual verifier and stall sidecar executions', async () => {
  vi.stubEnv('KODAX_VERIFIER_ALWAYS', '1');
  vi.stubEnv('KODAX_STALL_DETECT', '1');
  const sample = path.join(homeDir, 'sample.txt');
  await writeFile(sample, 'controlled read fixture');
  const probes = { verifier: 0, stall: 0 };
  class LogProvider extends KodaXBaseProvider {
    readonly name = 'execution-log-test';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_PRODUCT_CATALOG_TEST_KEY', model: 'log-test', supportsThinking: false };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      const [messages, tools] = args;
      const result = (name: string, input: Record<string, unknown>): KodaXStreamResult => ({
        textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: randomUUID(), name, input }], stopReason: 'tool_use',
      });
      if (tools.some(tool => tool.name === LEARNING_REVIEW_TOOL.name)) return result(LEARNING_REVIEW_TOOL.name,
        { memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard' } });
      if (tools.some(tool => tool.name === 'emit_sidecar_verdict')) {
        probes.verifier += 1; return result('emit_sidecar_verdict', { verdict: 'accept' });
      }
      if (tools.some(tool => tool.name === 'report_stall_judgment')) {
        probes.stall += 1; return result('report_stall_judgment', { isStuck: false, reason: 'Controlled repeated reads.' });
      }
      const reads = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(block => block.type === 'tool_result').length;
      if (reads < 5) return result('read', { path: sample });
      await new Promise<void>(resolve => setImmediate(resolve));
      return { textBlocks: [{ type: 'text', text: 'Inspected the sample.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('execution-log-test', () => new LogProvider());
  for (const enabled of [true, false]) {
    await first.config.patch({ verifierLog: enabled, stallLog: enabled });
    const session = await first.sessions.create({ projectPath: homeDir });
    await first.sessions.updateSettings(session.id, { provider: 'execution-log-test', agentMode: 'ama', permissionMode: 'full-access', maxIter: 10 });
    const seen: string[] = [];
    const observation = await second.sessions.observe(session.id, view => { seen.push(JSON.stringify(view.items)); });
    const before = { ...probes };
    try {
      const accepted = await first.inputs.submit({ sessionId: session.id, inputId: `logs-${enabled}`, text: 'Inspect the sample file repeatedly, then report.' });
      if (!accepted.runId) throw new Error('Expected immediate run');
      expect((await runtime.runs.await(accepted.runId)).phase).toBe('completed');
      await awaitLatestCodingMemoryReviewDrain(5_000);
      expect(probes.verifier).toBeGreaterThan(before.verifier);
      expect(probes.stall).toBeGreaterThan(before.stall);
      if (enabled) await expect.poll(() => seen.join('\n')).toContain('[Sidecar Verifier]');
      expect(seen.join('\n').includes('[Sidecar Verifier]')).toBe(enabled);
      expect(seen.join('\n').includes('[Stall Sidecar]')).toBe(enabled);
    } finally { observation.close(); }
  }
}, 30_000);

it('finds resumable Host sessions beyond the first window and agrees with the read-only snapshot', async () => {
  const projectRoot = process.cwd();
  const session = await first.sessions.create({ projectPath: projectRoot, title: 'Old resumable' });
  await first.sessions.updateSettings(session.id, { provider: 'product-catalog-test', agentMode: 'sa' });
  const run = await first.inputs.submit({ sessionId: session.id, inputId: 'discovery-fixture', text: 'Saved history' });
  if (!run.runId) throw new Error('Expected immediate fixture run');
  await first.runs.await(run.runId);
  const sessionsDir = path.join(homeDir, '.kodax', 'sessions');
  for (let start = 0; start < 1001; start += 48) {
    await Promise.all(Array.from({ length: Math.min(48, 1001 - start) }, (_, offset) => {
      const id = `empty-${start + offset}`;
      return writeFile(path.join(sessionsDir, `${id}.jsonl`), JSON.stringify({
        _type: 'meta', id, title: id, gitRoot: projectRoot, scope: 'user', activeMessageCount: 0,
        createdAt: '2099-01-01T00:00:00.000Z',
      }) + '\n');
    }));
  }
  const binding = createCliSessionCommands(first);
  expect((await binding.list!({ projectRoot, limit: 50 })).every(item => item.msgCount === 0)).toBe(true);
  expect(await resolveOneShotSession(first, { provider: 'product-catalog-test', session: { resume: true } }, 'continue')).toMatchObject({ sessionId: session.id, resumed: true });
  const candidates = (await binding.list!({ projectRoot, scope: 'user', limit: Number.MAX_SAFE_INTEGER })).filter(item => item.msgCount > 0);
  expect((await listCliResumeSessions({ projectRoot, sessionsDir })).map(item => item.id)).toEqual(candidates.map(item => item.id));
  for (let start = 0; start < 1001; start += 48) {
    await Promise.all(Array.from({ length: Math.min(48, 1001 - start) }, (_, offset) => {
      const id = `empty-${start + offset}`;
      return writeFile(path.join(sessionsDir, `${id}.jsonl`), JSON.stringify({
        _type: 'meta', id, title: id, gitRoot: projectRoot, scope: 'user', activeMessageCount: 1,
        createdAt: '2099-01-01T00:00:00.000Z',
      }) + '\n');
    }));
  }
  expect(await resolveBareResume({ cwd: projectRoot,
    listSessions: input => listCliResumeSessions({ ...input, sessionsDir }),
    pickSession: async items => { expect(items.length).toBe(1002); return items.find(item => item.id === session.id); },
  })).toMatchObject({ kind: 'continue', argv: ['-r', session.id] });
  await first.sessions.archive(session.id);
  expect(await second.sessions.read(session.id)).toMatchObject({ archived: true });
  await expect(resolveOneShotSession(first, { provider: 'product-catalog-test', session: { id: session.id, resume: true } }, 'resume')).rejects.toThrow('archived');
  expect((await listCliResumeSessions({ projectRoot, sessionsDir })).map(item => item.id)).not.toContain(session.id);
  await first.sessions.delete(session.id);
  await expect(second.sessions.read(session.id)).rejects.toThrow('Session not found:');
  await expect(resolveOneShotSession(first, { provider: 'product-catalog-test', session: { id: session.id, resume: true } }, 'resume')).rejects.toThrow('Session not found:');
}, 45_000);

it('changes the fallback used by real Workflow child execution', async () => {
  const requests: string[] = [];
  let failureStatus = 503;
  class FallbackProvider extends KodaXBaseProvider {
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_PRODUCT_CATALOG_TEST_KEY', model: 'fallback-test', supportsThinking: false };
    constructor(readonly name: string) { super(); }
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      if (args[0].some(message => typeof message.content === 'string' && message.content.startsWith('# Child Agent Task'))) requests.push(this.name);
      if (this.name === 'fallback-primary') throw new KodaXProviderError('Controlled upstream response body', this.name, { httpStatus: failureStatus, stage: 'transport' });
      return { textBlocks: [{ type: 'text', text: 'Fallback completed the inspection.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  for (const name of ['fallback-primary', 'fallback-secondary']) registerModelProvider(name, () => new FallbackProvider(name));
  for (const [enabled, status] of [[true, 503], [false, 503], [true, 401], [true, 400]] as const) {
    failureStatus = status;
    await first.config.patch({ fallbackProviders: enabled ? ['fallback-secondary'] : null });
    const session = await first.sessions.create({ projectPath: homeDir });
    await first.sessions.updateSettings(session.id, { provider: 'fallback-primary', permissionMode: 'full-access' });
    const before = requests.length;
    const started = await first.workflows.start({ sessionId: session.id, projectRoot: homeDir, source: {
      kind: 'inline', manifest: { name: 'fallback-config', description: 'Verify fallback setting.', readOnly: true, phases: ['investigate'], maxAgents: 1, maxConcurrency: 1, patterns: ['fan-out-and-synthesize'] },
      source: 'async function run(wf) { const result = await wf.runAgent({ name: "reader", prompt: "Inspect the supplied facts.", readOnly: true }); return { synthesis: result.finalText }; }',
    } });
    if (started.kind !== 'started') throw new Error(started.reason);
    const outcome = await first.runs.await(started.runId);
    await awaitLatestCodingMemoryReviewDrain(5_000);
    expect(requests.slice(before)).toContain('fallback-primary');
    expect(requests.slice(before).includes('fallback-secondary'), JSON.stringify({ outcome })).toBe(enabled && status === 503);
    if (!enabled || status !== 503) {
      expect(outcome.phase).toBe('failed');
      expect(outcome.error).not.toContain('Controlled upstream response body');
    }
  }
}, 30_000);
