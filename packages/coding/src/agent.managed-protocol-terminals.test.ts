import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, type KodaXMessage, type KodaXProviderConfig,
  type KodaXStreamResult, type KodaXToolDefinition } from '@kodax-ai/llm';
import { runKodaX } from './agent.js';
import { createExtensionRuntime } from './extensions/runtime.js';
import { awaitLatestCodingMemoryReviewDrain } from './memory-runtime.js';

describe('CAP-MANAGED-PROTO-002 public terminal results', () => {
  it.each(['completed', 'error', 'abort', 'limit'] as const)('retains merged compatibility payload on %s', async terminal => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-protocol-terminal-'));
    const context = { executionCwd: directory, gitRoot: directory, configHome: path.join(directory, '.kodax'),
      repoIntelligenceMode: 'off' as const, managedProtocolEmission: { enabled: true, role: 'evaluator' as const } };
    vi.stubEnv('KODAX_TERMINAL_FIXTURE_KEY', 'offline-no-http');
    const runtime = createExtensionRuntime();
    let calls = 0;
    class TerminalProvider extends KodaXBaseProvider {
      readonly name = 'protocol-terminal-fixture';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = { model: 'fixture', apiKeyEnv: 'KODAX_TERMINAL_FIXTURE_KEY' };
      async stream(_messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
        if (tools.some(tool => tool.name === 'commit_episode_learning_review')) return { textBlocks: [], thinkingBlocks: [],
          toolBlocks: [{ type: 'tool_use', id: 'review', name: 'commit_episode_learning_review', input: {
            memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard', reasonCodes: ['one_off'] },
          } }], stopReason: 'tool_use' };
        if (++calls === 1) return { textBlocks: [], thinkingBlocks: [], toolBlocks: [
          { type: 'tool_use', id: 'emit', name: 'fixture_emit', input: {} },
        ], stopReason: 'tool_use' };
        if (terminal === 'error') throw new Error('fixture terminal error');
        if (terminal === 'abort') throw Object.assign(new Error('fixture interrupt'), { name: 'AbortError' });
        return { textBlocks: [{ type: 'text', text: 'finished' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
      }
    }
    const unregister = registerModelProvider('protocol-terminal-fixture', () => new TerminalProvider());
    runtime.registerTool({ name: 'fixture_emit', description: 'Emit a compatibility payload without side effects',
      input_schema: { type: 'object', properties: {} }, handler: async (_input, ctx) => {
        ctx.emitManagedProtocol?.({ verdict: { source: 'evaluator', status: 'revise', followups: [], userFacingText: 'retained text' } });
        ctx.emitManagedProtocol?.({ verdict: { source: 'evaluator', status: 'accept', followups: [], userFacingText: 'final text' } });
        return 'emitted';
      } });
    try {
      const result = await runKodaX({ provider: 'protocol-terminal-fixture', reasoningMode: 'off', lsp: false,
        extensionRuntime: runtime, context, maxIter: terminal === 'limit' ? 1 : 3 }, 'Inspect and report the fixture result.');
      expect(result.managedProtocolPayload?.verdict).toEqual({ source: 'evaluator', status: 'accept', followups: [], userFacingText: 'final text' });
      if (terminal === 'error') expect(result.success).toBe(false);
      else expect(result.success).toBe(true);
      if (terminal === 'abort') expect(result.interrupted).toBe(true);
      if (terminal === 'limit') expect(result.limitReached).toBe(true);
      expect(calls).toBe(terminal === 'limit' ? 1 : 2);
    } finally {
      await awaitLatestCodingMemoryReviewDrain(5_000);
      unregister(); await runtime.dispose(); vi.unstubAllEnvs();
      if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-protocol-terminal-')) {
        throw new Error('Unsafe terminal fixture cleanup');
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
