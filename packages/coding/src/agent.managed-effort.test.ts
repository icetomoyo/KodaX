import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, type KodaXMessage, type KodaXProviderConfig,
  type KodaXReasoningRequest, type KodaXStreamResult, type KodaXToolDefinition } from '@kodax-ai/llm';
import type { KodaXProviderStreamOptions } from '@kodax-ai/llm';
import { runManagedTask } from './task-engine.js';
import { runKodaX } from './agent.js';
import { createSessionControl } from './running-session.js';
import { createExtensionRuntime } from './extensions/runtime.js';
import { awaitLatestCodingMemoryReviewDrain } from './memory-runtime.js';

it.for([
  ...['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'].map(effort => ({ effort, mode: 'ama', kind: 'none' })),
  ...['sa', 'ama'].flatMap(mode => ['session', 'defaults', 'hydrate', 'hook', 'runtime', 'race', 'aba'].map(kind => ({ effort: 'high', mode, kind }))),
  { effort: 'high', mode: 'ama', kind: 'budget' },
])('carries $mode effort $effort through Provider and tool context ($kind)', async ({ effort, mode, kind }, testContext) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-managed-effort-'));
  const requested: KodaXReasoningRequest[] = [];
  const inherited: (string | undefined)[] = [];
  const budgetCharges: number[] = [];
  const selections: { provider: string; model: string | undefined }[] = [];
  let enterHook!: () => void, releaseHook!: () => void;
  const hookEntered = new Promise<void>(resolve => { enterHook = resolve; });
  const hookReleased = new Promise<void>(resolve => { releaseHook = resolve; });
  const control = createSessionControl();
  const live = kind !== 'none';
  const runtime = live ? createExtensionRuntime() : undefined;
  runtime?.registerTool({ name: 'fixture_parent_effort', description: 'Read parent selection',
    input_schema: { type: 'object', properties: {} }, handler: async (_input, ctx) => {
      inherited.push(ctx.parentAgentConfig?.effort);
      if (kind === 'budget') {
        const budget = ctx.managedWorkBudget;
        if (!budget || !ctx.actorControl) throw new Error('Expected the root Actor budget binding.');
        const before = budget.spentBudget;
        await ctx.actorControl.spawn({ taskName: 'budget-child', objective: 'Reply briefly.' });
        budgetCharges.push(budget.spentBudget - before);
      }
      return 'Read selection.';
    } });
  vi.stubEnv('KODAX_MANAGED_EFFORT_KEY', 'offline-fixture');
  class Provider extends KodaXBaseProvider {
    constructor(readonly name = 'managed-effort-fixture') { super(); }
    readonly supportsThinking = true;
    protected readonly config: KodaXProviderConfig = { model: 'fixture', apiKeyEnv: 'KODAX_MANAGED_EFFORT_KEY' };
    async stream(_messages: KodaXMessage[], tools: KodaXToolDefinition[], _system: string,
      reasoning?: KodaXReasoningRequest, streamOptions?: KodaXProviderStreamOptions): Promise<KodaXStreamResult> {
      if (tools.some(tool => tool.name === 'read') && reasoning) {
        requested.push({ enabled: reasoning.enabled, effort: reasoning.effort });
        selections.push({ provider: this.name, model: streamOptions?.modelOverride });
      }
      if (live && requested.length === 1 && tools.some(tool => tool.name === 'fixture_parent_effort')) {
        if (kind === 'session' || kind === 'budget') control.setReasoning('deep', { effort: 'max' });
        return { textBlocks: [], thinkingBlocks: [], toolBlocks: [
          { type: 'tool_use', id: 'parent', name: 'fixture_parent_effort', input: {} },
        ], stopReason: 'tool_use' };
      }
      return { textBlocks: [{ type: 'text', text: 'Done.' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
    }
  }
  const unregister = registerModelProvider('managed-effort-fixture', () => new Provider());
  const unregisterNext = registerModelProvider('managed-effort-next', () => new Provider('managed-effort-next'));
  let running: ReturnType<typeof runManagedTask> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (kind === 'race' || kind === 'aba') {
      let first = true;
      runtime!.registerHook('provider:before', async context => {
        if (!first) return;
        first = false; context.setThinkingLevel('low'); context.replaceModel('prepared-model');
        enterHook(); await hookReleased;
      });
    }
    if (kind === 'hook') runtime!.registerHook('provider:before', context => context.setThinkingLevel('max'));
    if (kind === 'defaults' || kind === 'hydrate' || kind === 'runtime') {
      const extensionPath = path.join(directory, 'effort-extension.mjs');
      await writeFile(extensionPath, kind === 'defaults' ? `export default api => api.runtime.setThinkingLevel('max');`
        : `export default api => api.hook('${kind === 'hydrate' ? 'session:hydrate' : 'tool:before'}', () => api.runtime.setThinkingLevel('max'));`);
      await runtime!.loadExtension(extensionPath);
    }
    running = (mode === 'sa' ? runKodaX : runManagedTask)({ provider: 'managed-effort-fixture', agentMode: mode === 'sa' ? 'sa' : 'ama',
      effort, reasoningMode: 'quick', lsp: false, sessionControl: control, extensionRuntime: runtime, abortSignal: testContext.signal,
      context: { executionCwd: directory, gitRoot: directory, configHome: path.join(directory, '.kodax'),
        repoIntelligenceMode: 'off' }, maxIter: 5 }, 'Reply briefly.');
    if (kind === 'race' || kind === 'aba') {
      await Promise.race([hookEntered, running.then(() => { throw new Error('Run ended before the deferred Provider hook.'); }),
        new Promise<void>((_resolve, reject) => {
          onAbort = () => reject(testContext.signal.reason);
          testContext.signal.addEventListener('abort', onAbort, { once: true });
        })]);
      control.setProvider('managed-effort-next'); control.setModel('next-model'); control.setReasoning('deep', { effort: 'max' });
      if (kind === 'aba') {
        control.setProvider('managed-effort-fixture'); control.setModel(undefined); control.setReasoning('deep', { effort: 'high' });
      }
      releaseHook();
    }
    const result = await running;
    expect(result.success).toBe(true);
    if (kind === 'race' || kind === 'aba') {
      expect(requested).toEqual([{ enabled: true, effort: 'low' }, { enabled: true, effort: kind === 'race' ? 'max' : 'high' }]);
      expect(selections).toEqual([{ provider: 'managed-effort-fixture', model: 'prepared-model' },
        { provider: kind === 'race' ? 'managed-effort-next' : 'managed-effort-fixture', model: kind === 'race' ? 'next-model' : undefined }]);
    } else if (kind === 'budget') {
      expect(budgetCharges).toEqual([1]);
      expect(requested.length).toBeGreaterThanOrEqual(3);
      expect(requested.slice(1).every(request => request.effort === 'max')).toBe(true);
    } else expect(requested).toEqual(live ? [{ enabled: true, effort: ['defaults', 'hydrate', 'hook'].includes(kind) ? 'max' : 'high' },
      { enabled: true, effort: 'max' }] : [{ enabled: effort !== 'none', effort }]);
    expect(inherited).toEqual(live ? [kind === 'aba' ? 'high' : 'max'] : []);
  } finally {
    releaseHook();
    if (onAbort) testContext.signal.removeEventListener('abort', onAbort);
    try { await running; }
    finally {
      await awaitLatestCodingMemoryReviewDrain(5_000);
      unregister(); unregisterNext(); vi.unstubAllEnvs();
      await runtime?.dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});
