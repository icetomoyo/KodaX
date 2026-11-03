import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXMessage, type KodaXToolDefinition, type KodaXStreamResult } from '@kodax-ai/llm';
import { runManagedTask } from '@kodax-ai/coding';
import { FileSessionStorage } from '../packages/repl/src/interactive/storage.js';
import type { ExtensionRuntimeContract } from '../packages/coding/src/extensions/runtime-contract.js';

it('observes a yielded Script cell, rereads its cursor and shares bounded data only within its Run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-lifecycle-'));
  const storage = new FileSessionStorage({ sessionsDir: path.join(root, 'sessions'), configHome: root, cwd: root });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const executeCapability = vi.fn(async () => { await gate; return { kind: 'tool' as const, content: 'long task complete' }; });
  const extensionRuntime: ExtensionRuntimeContract = {
    listRunTools: () => [{ name: 'host_delay', description: 'Wait for the fixture.', capabilityId: 'fixture:delay',
      inputSchema: { type: 'object', properties: {} }, sideEffect: 'readonly', planModeAllowed: true }],
    searchCapabilities: async () => [], describeCapability: async () => undefined, executeCapability,
    readCapability: async () => ({ kind: 'resource', content: '' }), getCapabilityPrompt: async () => undefined,
    getCapabilityPromptContext: async () => undefined,
  };
  let requests = 0;
  let cellId = '';
  let firstWait = '';
  let newRun = false;
  let learningRequests = 0;
  vi.stubEnv('KODAX_SCRIPT_LIFECYCLE_KEY', 'offline');
  vi.stubEnv('KODAX_HOME', root);
  class Fixture extends KodaXBaseProvider {
    readonly name = 'script-lifecycle-offline';
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_SCRIPT_LIFECYCLE_KEY', model: 'fixture', supportsThinking: false };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      if (tools.some(tool => tool.name === 'commit_episode_learning_review')) {
        learningRequests += 1;
        return { textBlocks: [{ type: 'text', text: 'No learning candidates.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
      }
      const step = requests++;
      const call = (name: string, input: Record<string, unknown>): KodaXStreamResult => ({ textBlocks: [], thinkingBlocks: [],
        stopReason: 'tool_use', toolBlocks: [{ type: 'tool_use', id: `${newRun ? 'second' : 'first'}-step-${step}`, name, input }] });
      const results = messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
      const latest = results.at(-1);
      if (newRun) {
        expect(step).toBeLessThan(2);
        if (step === 0) return call('script_exec', { code: `
          const fresh = load('answer') ?? 'fresh';
          const errors = [];
          try { store('invalid', () => 1); } catch { errors.push('json'); }
          try { store('large', '界'.repeat(400000)); } catch { errors.push('bytes'); }
          for (let i = 0; i < 128; i++) store(String(i), i);
          try { store('overflow', 129); } catch { errors.push('entries'); }
          store('0', undefined); store('replacement', 42);
          return { fresh, errors, deleted: load('0') === undefined, replacement: load('replacement') };
        ` });
        expect(latest && JSON.parse(String(latest.content)).value).toEqual({ fresh: 'fresh', errors: ['json', 'bytes', 'entries'], deleted: true, replacement: 42 });
      } else if (step === 0) {
        expect(tools.map(tool => tool.name)).toContain('script_wait');
        return call('script_exec', { yield_time_ms: 2000, code:
          "store('answer',{value:42}); text('started'); const task = tools.host_delay({}); yield_control(); await task; text('finished'); return load('answer');" });
      } else if (step === 1) {
        const yielded = JSON.parse(String(latest?.content));
        expect(yielded.status).toBe('running');
        expect(yielded.cleanupComplete).toBe(false);
        expect(yielded.pendingCalls).toEqual([{ id: 1, name: 'host_delay', input: {}, status: 'pending' }]);
        cellId = yielded.cellId;
        release();
        return call('script_wait', { cell_id: cellId, cursor: 0, yield_time_ms: 2000 });
      } else if (step === 2) {
        firstWait = String(latest?.content);
        expect(JSON.parse(firstWait)).toMatchObject({ status: 'completed', cleanupComplete: true, value: { value: 42 }, outputs: ['started', 'finished'] });
        return call('script_wait', { cell_id: cellId, cursor: 0, yield_time_ms: 2000 });
      } else if (step === 3) {
        expect(String(latest?.content)).toBe(firstWait);
        return call('script_exec', { code: "return load('answer');" });
      } else {
        expect(step).toBe(4);
        expect(latest && JSON.parse(String(latest.content)).value).toEqual({ value: 42 });
      }
      return { textBlocks: [{ type: 'text', text: 'Observed task completion.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('script-lifecycle-offline', () => new Fixture());
  const options = { provider: 'script-lifecycle-offline', workMode: 'script' as const, agentMode: 'ama' as const,
    reasoningMode: 'off' as const, lsp: false, extensionRuntime, session: { id: 'lifecycle-session', storage },
    context: { executionCwd: root, gitRoot: root, repoIntelligenceMode: 'off' as const }, events: { beforeToolExecute: async () => true,
      onProviderRecovery: () => { release(); throw new Error('Unexpected fixture provider recovery'); } } };
  try {
    expect((await runManagedTask(options, 'Observe the long task and retain its data within this Run.')).success).toBe(true);
    expect(executeCapability).toHaveBeenCalledOnce();
    expect(requests).toBe(5);
    const records = (await storage.load('lifecycle-session'))?.extensionRecords ?? [];
    expect(records.filter(record => record.type === 'cell.settled')).toHaveLength(2);
    expect(records.filter(record => record.type === 'cell.output')).toHaveLength(2);
    newRun = true; requests = 0;
    expect((await runManagedTask(options, 'Check that the new Run has fresh temporary storage.')).success).toBe(true);
    expect(requests).toBe(2);
    expect(learningRequests).toBeLessThanOrEqual(2);
  } finally {
    release(); clearRuntimeModelProviders(); vi.unstubAllEnvs();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-script-lifecycle-')) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 30_000);
