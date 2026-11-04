import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, type KodaXMessage, type KodaXProviderConfig,
  type KodaXStreamResult, type KodaXToolDefinition } from '@kodax-ai/llm';
import { runManagedTask } from './task-engine.js';
import { runKodaX } from './agent.js';
import { combineExtensionRuntimes, createExtensionRuntime } from './extensions/runtime.js';
import { awaitLatestCodingMemoryReviewDrain } from './memory-runtime.js';
import type { KodaXEvents } from './types.js';

const POLICY_MESSAGE = 'Blocked by gate-coverage policy.';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

// Every dispatch path must run the extension `tool:before` policy exactly once
// per operation, whether or not the host passes events, whether the Session
// runtime is combined, and whether the model calls the tool directly or
// through the `tool_call` bridge. Child agents and Actor children run on these
// same entry points with the parent's runtime, so these rows cover them too.
it.for(['sa', 'ama'].flatMap(mode => ['plain', 'combined'].flatMap(runtimeKind =>
  [true, false].flatMap(withEvents => ['direct', 'bridge'].map(via => ({ mode, runtimeKind, withEvents, via }))))))(
  'enforces extension tool:before in $mode via $via ($runtimeKind runtime, events: $withEvents)',
  async ({ mode, runtimeKind, withEvents, via }, testContext) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-tool-gate-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const executed = vi.fn(async () => 'probe ran');
    const hookCalls: string[] = [];
    const transcripts: string[] = [];
    const sessionRuntime = createExtensionRuntime();
    const globalRuntime = createExtensionRuntime();
    cleanups.push(() => sessionRuntime.dispose(), () => globalRuntime.dispose());
    sessionRuntime.registerTool({ name: 'gate_probe', description: 'Gate probe',
      input_schema: { type: 'object', properties: {} }, sideEffect: 'readonly', toClassifierInput: () => '', handler: executed });
    sessionRuntime.registerHook('tool:before', ({ name }) => {
      hookCalls.push(name);
      return name === 'gate_probe' ? POLICY_MESSAGE : undefined;
    });
    vi.stubEnv('KODAX_TOOL_GATE_KEY', 'offline-fixture');
    cleanups.push(() => vi.unstubAllEnvs());
    let issued = false;
    class Provider extends KodaXBaseProvider {
      readonly name = 'tool-gate-fixture';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = { model: 'fixture', apiKeyEnv: 'KODAX_TOOL_GATE_KEY', supportsThinking: false };
      async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
        transcripts.push(JSON.stringify(messages));
        if (!issued && tools.some(tool => tool.name === 'gate_probe')) {
          issued = true;
          return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
            toolBlocks: [via === 'direct'
              ? { type: 'tool_use', id: 'probe-1', name: 'gate_probe', input: {} }
              : { type: 'tool_use', id: 'probe-1', name: 'tool_call', input: { name: 'gate_probe', input: {} } }] };
        }
        return { textBlocks: [{ type: 'text', text: 'Done.' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
      }
    }
    cleanups.push(registerModelProvider('tool-gate-fixture', () => new Provider()));
    const events: KodaXEvents | undefined = withEvents ? { beforeToolExecute: async () => true } : undefined;
    const run = mode === 'sa' ? runKodaX : runManagedTask;
    const result = await run({ provider: 'tool-gate-fixture', agentMode: mode === 'sa' ? 'sa' : 'ama', reasoningMode: 'quick',
      lsp: false, events, abortSignal: testContext.signal,
      extensionRuntime: runtimeKind === 'combined' ? combineExtensionRuntimes(sessionRuntime, globalRuntime) : sessionRuntime,
      context: { executionCwd: directory, gitRoot: directory, configHome: path.join(directory, '.kodax'), repoIntelligenceMode: 'off' },
      maxIter: 4 }, 'Run the probe.');
    await awaitLatestCodingMemoryReviewDrain(5_000);

    expect(result.success).toBe(true);
    expect(issued).toBe(true);
    expect(hookCalls).toEqual(['gate_probe']);
    expect(executed).not.toHaveBeenCalled();
    expect(transcripts.some(text => text.includes(POLICY_MESSAGE))).toBe(true);
  },
);
