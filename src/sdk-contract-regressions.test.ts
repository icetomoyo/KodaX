import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders, getRunScopedConfig,
  type KodaXStreamResult, type KodaXProviderConfig } from '@kodax-ai/llm';
import { awaitLatestCodingMemoryReviewDrain, LEARNING_REVIEW_TOOL } from '@kodax-ai/coding';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';
import { createRuntimeDaemonClient } from './runtime-daemon/client.js';
import { KodaXExtensionRuntime } from '../packages/coding/src/extensions/runtime.js';
import { dispatchManagedTask } from '../packages/coding/src/task-engine.js';
import { applyConfigEnvironment } from '../packages/repl/src/common/utils.js';
import type { KodaXRuntime } from './sdk-runtime.js';

const directories: string[] = [];

it('admits Partner identity with generic Agent tools without requiring a persona profile', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-sdk-partner-admission-')); directories.push(homeDir);
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'anthropic' });
  try {
    const client = toKodaXProductClient(runtime);
    const session = await client.sessions.create({ surface: 'partner', profileId: 'space-partner', projectPath: homeDir });
    expect(await client.sessions.read(session.id)).toMatchObject({ surface: 'partner', profileId: 'space-partner' });
    await client.sessions.updateSettings(session.id, { workMode: 'agent', permissionMode: 'full-access' });
    const run = await client.runs.startTool({ sessionId: session.id, inputId: 'unbound', rawInput: 'Write a document',
      name: 'write', input: { path: join(homeDir, 'document.txt'), content: 'Partner generic Agent' } });
    expect((await client.runs.await(run.runId)).phase).toBe('completed');
  } finally { await runtime.close(); }
});
afterEach(async () => {
  await awaitLatestCodingMemoryReviewDrain(5_000);
  clearRuntimeModelProviders(); vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('audit: Script selected with supported SA settings should execute via a compatible managed entry', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-sdk-script-sa-audit-'));
  directories.push(homeDir);
  let modelCalls = 0;
  class ScriptAuditProvider extends KodaXBaseProvider {
    readonly name = 'audit-script-sa'; readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_AUDIT_KEY', model: 'fixture', supportsThinking: false };
    async stream(): Promise<KodaXStreamResult> {
      modelCalls += 1;
      return { textBlocks: [{ type: 'text', text: 'Done' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('audit-script-sa', () => new ScriptAuditProvider());
  vi.stubEnv('KODAX_AUDIT_KEY', 'test-only');
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'audit-script-sa' });
  try {
    const client = toKodaXProductClient(runtime);
    const session = await client.sessions.create({ title: 'SA Script audit', projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { agentMode: 'sa', workMode: 'script', permissionMode: 'full-access' });
    expect(await client.sessions.getSettings(session.id)).toMatchObject({ agentMode: 'sa', workMode: 'script' });
    const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'script-sa-audit', text: 'Reply briefly.' });
    if (!accepted.runId) throw new Error('Expected an admitted Run');
    const result = await client.runs.await(accepted.runId);
    expect(modelCalls).toBeGreaterThan(0);
    expect({ phase: result.phase, error: String(result.error) }).toEqual({ phase: 'completed', error: 'undefined' });
  } finally { await runtime.close(); }
});

it.each(['permissionMode', 'planModeEffort'] as const)('audit: live %s change should update actual plan effort', async change => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-sdk-plan-effort-audit-'));
  directories.push(homeDir);
  const sample = join(homeDir, 'sample.txt');
  await writeFile(sample, 'Evidence');
  const entered = gate(); const release = gate();
  const requests: unknown[] = [];
  class AuditProvider extends KodaXBaseProvider {
    readonly name = 'audit-plan-effort'; readonly supportsThinking = true;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_AUDIT_KEY', model: 'fixture', supportsThinking: true };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      if (args[1].some(tool => tool.name === LEARNING_REVIEW_TOOL.name)) return {
        textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{ type: 'tool_use', id: 'review', name: LEARNING_REVIEW_TOOL.name,
          input: { memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard' } } }],
      };
      requests.push(typeof args[3] === 'object' ? { enabled: args[3].enabled, effort: args[3].effort } : args[3]);
      if (requests.length === 1) {
        entered.resolve(); await release.promise;
        return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{ type: 'tool_use', id: 'read-evidence', name: 'read', input: { path: sample } }] };
      }
      return { textBlocks: [{ type: 'text', text: 'Evidence read.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('audit-plan-effort', () => new AuditProvider());
  vi.stubEnv('KODAX_AUDIT_KEY', 'test-only');
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'audit-plan-effort' });
  try {
    const client = toKodaXProductClient(runtime);
    await client.config.patch({ effort: 'low' });
    const session = await client.sessions.create({ title: 'Plan effort audit', projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { provider: 'audit-plan-effort', agentMode: 'sa',
      permissionMode: change === 'permissionMode' ? 'full-access' : 'plan', planModeEffort: change === 'permissionMode' ? 'high' : 'low' });
    const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'effort-audit', text: 'Read the supplied sample file and report.' });
    if (!accepted.runId) throw new Error('Expected an admitted Run');
    await entered.promise;
    expect(requests[0]).toEqual({ enabled: true, effort: 'low' });
    await client.sessions.updateSettings(session.id, change === 'permissionMode' ? { permissionMode: 'plan' } : { planModeEffort: 'high' });
    let effectiveEffort: string | undefined;
    const observation = await client.sessions.observe(session.id, view => { effectiveEffort = view.settings.effort; });
    observation.close();
    expect(effectiveEffort).toBe('high');
    release.resolve();
    await client.runs.await(accepted.runId);
    expect(requests[1]).toEqual({ enabled: true, effort: 'high' });
  } finally { release.resolve(); await runtime.close(); }
});

it('audit: Actor checkpoint recovery intent should survive the daemon proxy', async () => {
  const sent: { method: string; params: unknown }[] = [];
  const runtime = createRuntimeDaemonClient({ identity: { runtimeId: 'probe', mode: 'daemon', profile: 'default',
    startedAt: new Date().toISOString(), version: '0.7.97-alpha.11' },
    capabilities: { actorControlPlane: { version: 1, methodNamespace: 'agents' }, actorCheckpointRecovery: { version: 1 } },
    transport: { request: async (method, params) => { sent.push({ method, params }); return { delivery: 'current_turn' }; },
      subscribe: () => ({ close() {} }) },
  });
  try {
    await toKodaXProductClient(runtime).agents.followup('s', '/root/expert', '', { expectedRevision: 7, resumeCheckpoint: true });
    expect(sent.find(call => call.method === 'agents.followup')?.params).toMatchObject({ resumeCheckpoint: true });
  } finally { await runtime.close(); }
});

it('audit: public numeric token configuration should retain its declared type', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-sdk-redaction-audit-')); directories.push(homeDir);
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
  try {
    const client = toKodaXProductClient(runtime);
    await client.config.patch({ maxOutputTokens: 1234 });
    expect((await client.config.read()).maxOutputTokens).toBe(1234);
  } finally { await runtime.close(); }
});

it('rejects unsupported profile or checkpoint bindings before sending work to an older Host', async () => {
  const sent: string[] = [];
  const runtime = createRuntimeDaemonClient({ identity: { runtimeId: 'old-host', mode: 'daemon', profile: 'default',
    startedAt: new Date().toISOString(), version: '0.7.97-alpha.11' },
    capabilities: { actorControlPlane: { version: 1, methodNamespace: 'agents' } },
    transport: { request: async method => { sent.push(method); return { delivery: 'next_turn' }; },
      subscribe: () => ({ close() {} }) },
  });
  try {
    const bound = toKodaXProductClient(runtime, async () => ({ profile: { agentProfile: { id: 'partner' }, tools: ['read'] } }));
    await expect(bound.inputs.submit({ sessionId: 's', inputId: 'stable', text: 'Read evidence' }))
      .rejects.toMatchObject({ code: 'daemon_upgrade_required' });
    const ordinary = toKodaXProductClient(runtime);
    await expect(ordinary.agents.followup('s', '/root/expert', '', { resumeCheckpoint: true }))
      .rejects.toMatchObject({ code: 'daemon_upgrade_required' });
    expect(sent).toEqual([]);
    await ordinary.agents.followup('s', '/root/expert', 'Continue normally');
    expect(sent).toEqual(['agents.followup']);
  } finally { await runtime.close(); }
});

it('applies saved execution defaults only to subsequent Runs without changing ambient environment', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-sdk-defaults-')); directories.push(homeDir);
  vi.stubEnv('KODAX_MAX_OUTPUT_TOKENS', undefined);
  vi.stubEnv('KODAX_AUDIT_KEY', 'fixture');
  const snapshots: unknown[] = [];
  class Provider extends KodaXBaseProvider {
    readonly name = 'audit-defaults'; readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_AUDIT_KEY', model: 'fixture', maxOutputTokens: 7777, supportsThinking: false };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      if (!args[1].some(tool => tool.name === LEARNING_REVIEW_TOOL.name)) {
        snapshots.push({ max: this.getEffectiveMaxOutputTokens(), scoped: structuredClone(getRunScopedConfig()) });
      }
      return { textBlocks: [{ type: 'text', text: 'Done' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('audit-defaults', () => new Provider());
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'audit-defaults' });
  try {
    const client = toKodaXProductClient(runtime);
    const session = await client.sessions.create({ projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access', reasoningMode: 'off' });
    for (const maxOutputTokens of [1234, 2345]) {
      await client.config.patch({ maxOutputTokens, disablePromptCache: true, lsp: false, fastModel: 'fast-fixture' });
      await client.config.reload();
      const before = snapshots.length;
      const accepted = await client.inputs.submit({ sessionId: session.id, inputId: `config-${maxOutputTokens}`, text: 'Reply briefly.' });
      await client.runs.await(accepted.runId!);
      expect(snapshots[before]).toMatchObject({ max: maxOutputTokens, scoped: { maxOutputTokens,
        disablePromptCache: true, lsp: false, modelTiers: { fast: { model: 'fast-fixture' } } } });
      expect(await client.config.readEffective()).toMatchObject({ maxOutputTokens: { value: maxOutputTokens, applied: true },
        application: { maxOutputTokens: 'next_run', locale: 'restart' } });
    }
    expect(process.env.KODAX_MAX_OUTPUT_TOKENS).toBeUndefined();
    applyConfigEnvironment({ maxOutputTokens: 2345, disablePromptCache: true, lsp: false, fastModel: 'fast-fixture' });
    await client.config.patch({ maxOutputTokens: null, disablePromptCache: null, lsp: null, fastModel: null });
    await client.config.reload();
    const before = snapshots.length;
    const cleared = await client.inputs.submit({ sessionId: session.id, inputId: 'cleared', text: 'Reply briefly.' });
    await client.runs.await(cleared.runId!);
    expect(snapshots[before]).toMatchObject({ max: 7777 });
    expect((await client.config.readEffective()).maxOutputTokens?.value).toBeUndefined();
    process.env.KODAX_MAX_OUTPUT_TOKENS = '8888';
    await client.config.patch({ maxOutputTokens: 4096 });
    await client.config.reload();
    const externalBefore = snapshots.length;
    const external = await client.inputs.submit({ sessionId: session.id, inputId: 'external-env', text: 'Reply briefly.' });
    await client.runs.await(external.runId!);
    expect(snapshots[externalBefore]).toMatchObject({ max: 8888 });
    await client.config.patch({ maxOutputTokens: null });
    expect(process.env.KODAX_MAX_OUTPUT_TOKENS).toBe('8888');
    expect((await client.config.readEffective()).maxOutputTokens).toMatchObject({ value: 8888, source: 'environment', applied: true });
  } finally { await runtime.close(); }
});

it('keeps configuration application support unknown on an older Host', async () => {
  const runtime = { config: { readEffective: async () => ({ entries: {} }) } } as unknown as KodaXRuntime;
  const result = await toKodaXProductClient(runtime).config.readEffective();
  expect(result.application).toBeUndefined();
  expect(result.maxOutputTokens).toBeUndefined();
});

it('audit: effective tool scope should match the active extension tool ceiling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kodax-sdk-scope-audit-')); directories.push(directory);
  const runtime = new KodaXExtensionRuntime();
  try {
    const file = join(directory, 'only-read.mjs');
    await writeFile(file, "export default api => { api.runtime.setActiveTools(['read']); };\n");
    await runtime.loadExtension(file);
    const configs: import('@kodax-ai/coding').KodaXEffectiveTaskConfig[] = [];
    const schemas: string[][] = [];
    class ScopeProvider extends KodaXBaseProvider {
      readonly name = 'audit-scope'; readonly supportsThinking = false;
      protected readonly config = { apiKeyEnv: 'KODAX_AUDIT_KEY', model: 'fixture', supportsThinking: false };
      async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
        if (!args[1].some(tool => tool.name === LEARNING_REVIEW_TOOL.name)) schemas.push(args[1].map(tool => tool.name));
        return { textBlocks: [{ type: 'text', text: 'Done' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
      }
    }
    registerModelProvider('audit-scope', () => new ScopeProvider());
    vi.stubEnv('KODAX_AUDIT_KEY', 'fixture');
    await dispatchManagedTask({ provider: 'audit-scope', agentMode: 'ama', workMode: 'agent', extensionRuntime: runtime,
      context: { executionCwd: directory, configHome: directory },
      events: { onEffectiveConfig: config => configs.push(config) } }, 'Inspect notes');
    expect(schemas.length).toBeGreaterThan(0);
    expect(configs.length).toBeGreaterThan(0);
    expect(configs[0]!.toolScope).toEqual(['read']);
    expect(configs[0]!.modelToolScope).toEqual(schemas[0]);
    expect(configs[0]!.toolScope).not.toContain('run_skill_script');
  } finally { await runtime.dispose(); }
});
