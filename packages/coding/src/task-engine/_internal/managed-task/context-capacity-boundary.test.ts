import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TOOL_OUTPUT_DIR_ENV } from '../../../tools/truncate.js';
import {
  estimateTokens,
  reclaimReservedResponseTokens,
} from '@kodax-ai/agent';
import {
  KodaXBaseProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { KodaXOpenAICompatProvider } from '../../../../../llm/src/providers/openai.js';
import type { KodaXOptions } from '../../../types.js';
import { buildManagedTaskCompactionHook } from './compaction.js';
import { runCompactionLifecycle } from '../../../agent-runtime/middleware/compaction-orchestration.js';
import { Runner, createAgent } from '@kodax-ai/agent';
import { KodaXContextOverflowError } from '@kodax-ai/llm';

let outputDirectory: string;
beforeEach(async () => {
  outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-boundary-'));
  vi.stubEnv(TOOL_OUTPUT_DIR_ENV, outputDirectory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(outputDirectory, { recursive: true, force: true });
});

// Recovery regression: real parser, SDK transport, compactor
// and AMA hook. Only the remote model response is replaced. No live connection.
class OfflineTransportProvider extends KodaXOpenAICompatProvider {
  readonly name = 'offline-capacity';
  readonly attempts: number[] = [];
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'UNUSED_OFFLINE_KEY', model: 'offline-model',
    supportsThinking: false, contextWindow: 131_072, maxOutputTokens: 32_768,
  };

  constructor(readonly actualInput: number) {
    super();
    this.client = new OpenAI({
      apiKey: 'offline-test-only', baseURL: 'https://capacity.invalid/v1', maxRetries: 0,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const output = Number(body.max_tokens ?? body.max_completion_tokens);
        this.attempts.push(output);
        return this.response(output);
      },
    });
  }

  private response(output: number): Response {
    if (this.actualInput + output > 131_072) {
      const message = `This model's maximum context length is 131072 tokens. However, you requested ${output} output tokens and your prompt contains ${this.actualInput} input tokens, for a total of ${this.actualInput + output} tokens. Please reduce the length of the input prompt or the number of requested output tokens.`;
      return new Response(JSON.stringify({ error: { message, type: 'BadRequestError' } }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    const chunk = { id: 'offline', object: 'chat.completion.chunk', created: 0,
      model: 'offline-model', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: this.actualInput, completion_tokens: 1, total_tokens: this.actualInput + 1 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }
}

class OfflineSummaryProvider extends KodaXBaseProvider {
  readonly name = 'offline-summary';
  readonly supportsThinking = false;
  summaryCalls = 0;
  failSummary = false;
  protected readonly config: KodaXProviderConfig;

  constructor(reserve: number) {
    super();
    this.config = { apiKeyEnv: 'UNUSED_OFFLINE_KEY', model: 'offline-model',
      supportsThinking: false, contextWindow: 131_072, maxOutputTokens: reserve };
  }

  async stream(): Promise<KodaXStreamResult> {
    this.summaryCalls += 1;
    if (this.failSummary) throw new Error('offline summary outage');
    return { textBlocks: [{ type: 'text', text:
      '## Goal\nComplete the Python and HTML changes.\n## Progress\nThe old implementation was inspected.\n## Next Steps\nUse the latest tool evidence to finish the requested work.' }],
      toolBlocks: [], thinkingBlocks: [] };
  }
}

function latestToolPair(): KodaXMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'bash', input: { command: 'cat server.py' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: "print('x')\n".repeat(17_000) }] },
  ];
}

async function makeHook(messages: KodaXMessage[], currentTokens: number, reserve: number) {
  const provider = new OfflineSummaryProvider(reserve);
  const committed = vi.fn();
  const ref = { current: { currentTokens, baselineEstimatedTokens: estimateTokens(messages), source: 'api' as const } };
  const hook = await buildManagedTaskCompactionHook({ provider: 'offline-summary',
    events: { onCompactedMessages: committed } } as KodaXOptions, {
    resolvedContextCapacity: { provider, activeModel: 'offline-model', contextWindow: 131_072,
      compactionConfig: { enabled: true, triggerPercent: 75, triggerTokens: 80_000 } },
    contextTokenSnapshotRef: ref,
  });
  if (!hook) throw new Error('Expected an enabled compaction hook');
  return { hook, provider, committed, ref };
}

describe('offline context capacity boundary recovery', () => {
  it('rearms an open AMA summary breaker after durable tool relief', async () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Finish the project.' },
      { role: 'assistant', content: 'old implementation evidence '.repeat(400) }, ...latestToolPair(),
    ];
    const attempt = await makeHook(messages, 100_000, 32_768);
    attempt.provider.failSummary = true;
    for (let index = 0; index < 3; index += 1) await attempt.hook(messages);
    expect(attempt.provider.summaryCalls).toBe(3);
    attempt.ref.current.currentTokens = 130_000;
    const reduced = await attempt.hook(messages) as KodaXMessage[];
    expect(reduced).toBeDefined();
    expect(attempt.provider.summaryCalls).toBe(3);
    attempt.provider.failSummary = false;
    attempt.ref.current = { currentTokens: 100_000, baselineEstimatedTokens: estimateTokens(reduced), source: 'api' };
    await attempt.hook(reduced);
    expect(attempt.provider.summaryCalls).toBe(4);
  });
  it('routes provider rejection through the real AMA compactor and Runner retry', async () => {
    const messages = latestToolPair();
    const attempt = await makeHook(messages, 60_000, 3_000);
    let calls = 0;
    const result = await Runner.run(createAgent({ name: 'offline-worker', instructions: 'sys' }), messages, {
      tracer: null, compactionHook: attempt.hook,
      llm: async (request) => {
        calls += 1;
        if (calls === 1) throw new KodaXContextOverflowError({ contextWindow: 131_072, inputTokensKind: 'unknown' });
        expect(attempt.committed).toHaveBeenCalled();
        expect(JSON.stringify(request)).toContain('KODAX_RESULT_INCOMPLETE');
        return 'done after recovery';
      },
    });
    expect(result.output).toBe('done after recovery');
    expect(calls).toBe(2);
  });

  it('applies the same persisted latest-batch relief in the SA lifecycle', async () => {
    const messages = latestToolPair();
    const persist = vi.fn();
    const result = await runCompactionLifecycle({ messages, needsCompact: true, compactConsecutiveFailures: 0,
      compactionConfig: { enabled: true, triggerPercent: 75, triggerTokens: 80_000 },
      provider: new OfflineSummaryProvider(3_000), contextWindow: 131_072, systemPrompt: '',
      currentTokens: 125_541, reservedResponseTokens: 3_000, events: { onCompactedMessages: persist },
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.contextTokenSnapshot?.currentTokens).toBeLessThanOrEqual(124_341);
    expect(result.stillOverCapacity).toBe(false);
  });
  it('recovers an exact vLLM context rejection with a smaller output budget', async () => {
    const provider = new OfflineTransportProvider(103_456);
    await expect(provider.stream([{ role: 'user', content: 'synthetic token fixture' }], [], '', false))
      .resolves.toMatchObject({ textBlocks: [{ type: 'text', text: 'done' }] });
    expect(provider.attempts).toEqual([32_768, 26_616]);
    const control = new OfflineTransportProvider(103_456);
    await expect(control.stream([{ role: 'user', content: 'synthetic token fixture' }], [], '', false,
      { maxOutputTokensOverride: 26_616 })).resolves.toMatchObject({ textBlocks: [{ type: 'text', text: 'done' }] });
    expect(control.attempts).toEqual([26_616]);
  });

  it('lets a reclaimable reserve pass through the real AMA compactor', async () => {
    const messages = latestToolPair();
    const failing = await makeHook(messages, 95_773, 32_768);
    await expect(failing.hook(messages)).resolves.toBeUndefined();
    expect(failing.provider.summaryCalls).toBe(0);
    expect(failing.committed).not.toHaveBeenCalled();
    const reserve = reclaimReservedResponseTokens({ contextWindow: 131_072, currentTokens: 95_773, reservedResponseTokens: 32_768 });
    expect(reserve).toBe(32_425);
    const control = await makeHook(messages, 95_773, reserve);
    await expect(control.hook(messages)).resolves.toBeUndefined();
  });

  it('commits a successful summary when a smaller response reserve makes it legal', async () => {
    const messages: KodaXMessage[] = [{ role: 'user', content: 'Finish the requested changes.' },
      { role: 'assistant', content: 'old implementation evidence '.repeat(400) }, ...latestToolPair()];
    const attempt = await makeHook(messages, 100_000, 32_768);
    await expect(attempt.hook(messages)).resolves.toBeInstanceOf(Array);
    expect(attempt.provider.summaryCalls).toBe(1);
    expect(attempt.committed).toHaveBeenCalledTimes(1);
    const control = await makeHook(messages, 100_000, 3_000);
    await expect(control.hook(messages)).resolves.toBeInstanceOf(Array);
    expect(control.provider.summaryCalls).toBe(1);
    expect(control.committed).toHaveBeenCalledTimes(1);
  });

  it('recovers the latest completed tool batch and persists the replacement before continuing', async () => {
    const messages = latestToolPair();
    const attempt = await makeHook(messages, 125_541, 3_000);
    await expect(attempt.hook(messages)).resolves.toBeInstanceOf(Array);
    expect(attempt.provider.summaryCalls).toBe(0);
    expect(attempt.committed).toHaveBeenCalledTimes(1);
    const reduced = attempt.committed.mock.calls[0]![0] as KodaXMessage[];
    await expect(attempt.hook(reduced)).resolves.toBeUndefined();
    expect(estimateTokens(messages)).toBeGreaterThan(46_000);
  });
});
