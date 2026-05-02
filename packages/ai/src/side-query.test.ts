import { describe, expect, it } from 'vitest';
import { sideQuery } from './side-query.js';
import { KodaXBaseProvider } from './providers/base.js';
import { createCostTracker } from './cost-tracker.js';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXTextBlock,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from './types.js';

type StreamArgs = {
  messages: KodaXMessage[];
  tools: KodaXToolDefinition[];
  system: string;
  reasoning?: boolean | KodaXReasoningRequest;
  streamOptions?: KodaXProviderStreamOptions;
  signal?: AbortSignal;
};

type StreamImpl = (args: StreamArgs) => Promise<KodaXStreamResult>;

class StubProvider extends KodaXBaseProvider {
  readonly name = 'stub';
  readonly supportsThinking = true;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'STUB_API_KEY',
    model: 'stub-default',
    supportsThinking: true,
    reasoningCapability: 'none',
  };

  public capturedCalls: StreamArgs[] = [];

  constructor(private readonly streamImpl: StreamImpl) {
    super();
  }

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    const args: StreamArgs = { messages, tools, system, reasoning, streamOptions, signal };
    this.capturedCalls.push(args);
    return this.streamImpl(args);
  }
}

const text = (s: string): KodaXTextBlock => ({ type: 'text', text: s });
const toolUse = (name: string): KodaXToolUseBlock => ({
  type: 'tool_use',
  id: 'call_1',
  name,
  input: {},
});

const baseMessages: readonly KodaXMessage[] = [
  { role: 'user', content: 'classify this' },
];

const okResult = (overrides: Partial<KodaXStreamResult> = {}): KodaXStreamResult => ({
  textBlocks: [text('ok')],
  toolBlocks: [],
  thinkingBlocks: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: 'end_turn',
  ...overrides,
});

describe('sideQuery — happy path', () => {
  it('returns concatenated text from textBlocks and provider usage', async () => {
    const provider = new StubProvider(async () => okResult({
      textBlocks: [text('<block>no</block>'), text('<reason>safe</reason>')],
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    }));

    const result = await sideQuery({
      provider,
      model: 'stub-default',
      system: 'sys',
      messages: baseMessages,
      querySource: 'auto_mode',
    });

    expect(result.text).toBe('<block>no</block><reason>safe</reason>');
    expect(result.usage.totalTokens).toBe(120);
    expect(result.stopReason).toBe('end_turn');
    expect(result.error).toBeUndefined();
  });

  it('passes empty tools, model override via streamOptions, and reasoning off by default', async () => {
    const provider = new StubProvider(async () => okResult());

    await sideQuery({
      provider,
      model: 'requested-model',
      system: 'sys',
      messages: baseMessages,
      querySource: 'auto_mode',
    });

    const call = provider.capturedCalls[0]!;
    expect(call.tools).toEqual([]);
    expect(call.system).toBe('sys');
    expect(call.streamOptions?.modelOverride).toBe('requested-model');
    expect(call.reasoning).toEqual({ mode: 'off' });
  });

  it('honors caller-provided reasoning override', async () => {
    const provider = new StubProvider(async () => okResult());

    await sideQuery({
      provider,
      model: 'm',
      system: 's',
      messages: baseMessages,
      querySource: 'auto_mode',
      reasoning: { mode: 'deep' },
    });

    expect(provider.capturedCalls[0]!.reasoning).toEqual({ mode: 'deep' });
  });

  it('maps provider stopReason max_tokens to SideQueryStopReason max_tokens', async () => {
    const provider = new StubProvider(async () => okResult({
      textBlocks: [text('truncated...')],
      stopReason: 'max_tokens',
    }));

    const result = await sideQuery({
      provider, model: 'm', system: 's',
      messages: baseMessages, querySource: 'auto_mode',
    });

    expect(result.stopReason).toBe('max_tokens');
  });

  it('treats stop_sequence and tool_use stopReasons as end_turn (text-only completion)', async () => {
    for (const raw of ['stop_sequence', 'end_turn', undefined]) {
      const provider = new StubProvider(async () => okResult({ stopReason: raw }));
      const result = await sideQuery({
        provider, model: 'm', system: 's',
        messages: baseMessages, querySource: 'auto_mode',
      });
      expect(result.stopReason).toBe('end_turn');
    }
  });
});

describe('sideQuery — cost tracking', () => {
  it('records usage to cost tracker with querySource as role', async () => {
    const provider = new StubProvider(async () => okResult({
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedReadTokens: 50,
        cachedWriteTokens: 7,
      },
    }));
    const tracker = createCostTracker();

    const result = await sideQuery({
      provider, model: 'stub-default', system: 'sys',
      messages: baseMessages, querySource: 'auto_mode',
      costTracker: tracker,
    });

    expect(result.costTracker).toBeDefined();
    expect(result.costTracker!.records).toHaveLength(1);
    const rec = result.costTracker!.records[0]!;
    expect(rec.role).toBe('auto_mode');
    expect(rec.inputTokens).toBe(100);
    expect(rec.outputTokens).toBe(20);
    expect(rec.cacheReadTokens).toBe(50);
    expect(rec.cacheWriteTokens).toBe(7);
    expect(rec.provider).toBe('stub');
    expect(rec.model).toBe('stub-default');
    // Original tracker not mutated (immutable contract)
    expect(tracker.records).toHaveLength(0);
  });

  it('does not record usage when sideQuery contract is violated (tool_use blocks returned)', async () => {
    const provider = new StubProvider(async () => okResult({
      textBlocks: [text('partial')],
      toolBlocks: [toolUse('Bash')],
      usage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998 },
      stopReason: 'tool_use',
    }));
    const tracker = createCostTracker();

    const result = await sideQuery({
      provider, model: 'm', system: 's',
      messages: baseMessages, querySource: 'auto_mode',
      costTracker: tracker,
    });

    expect(result.stopReason).toBe('error');
    // Returned tracker is the input tracker (no mutation, no advance)
    expect(result.costTracker).toBe(tracker);
    expect(result.costTracker!.records).toHaveLength(0);
  });

  it('returns undefined costTracker when not provided', async () => {
    const provider = new StubProvider(async () => okResult());

    const result = await sideQuery({
      provider, model: 'm', system: 's',
      messages: baseMessages, querySource: 'auto_mode',
    });

    expect(result.costTracker).toBeUndefined();
  });
});

describe('sideQuery — tool-call rejection', () => {
  it('returns error stopReason when provider returns tool_use blocks', async () => {
    const provider = new StubProvider(async () => okResult({
      textBlocks: [text('partial')],
      toolBlocks: [toolUse('Bash')],
      stopReason: 'tool_use',
    }));

    const result = await sideQuery({
      provider, model: 'm', system: 's',
      messages: baseMessages, querySource: 'auto_mode',
    });

    expect(result.stopReason).toBe('error');
    expect(result.error?.message).toMatch(/tool_use/i);
    // Cost tracker should NOT be advanced when sideQuery contract is violated
    // (caller did not pass one in this test, just verify field handling)
    expect(result.costTracker).toBeUndefined();
  });
});

describe('sideQuery — failure modes', () => {
  it('returns timeout stopReason when timeoutMs elapses', async () => {
    const provider = new StubProvider(async ({ signal }) => {
      return new Promise<KodaXStreamResult>((_, reject) => {
        signal!.addEventListener(
          'abort',
          () => reject(new DOMException('Request aborted', 'AbortError')),
          { once: true },
        );
      });
    });

    const result = await sideQuery({
      provider, model: 'm', system: 's',
      messages: baseMessages, querySource: 'auto_mode',
      timeoutMs: 20,
    });

    expect(result.stopReason).toBe('timeout');
    expect(result.text).toBe('');
    expect(result.error).toBeDefined();
  });

  it('returns aborted stopReason when caller signal fires before timeout', async () => {
    const controller = new AbortController();
    const provider = new StubProvider(async ({ signal }) => {
      return new Promise<KodaXStreamResult>((_, reject) => {
        signal!.addEventListener(
          'abort',
          () => reject(new DOMException('Request aborted', 'AbortError')),
          { once: true },
        );
      });
    });

    const promise = sideQuery({
      provider, model: 'm', system: 's',
      messages: baseMessages, querySource: 'auto_mode',
      abortSignal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 5);

    const result = await promise;
    expect(result.stopReason).toBe('aborted');
  });

  it('returns aborted stopReason when caller signal is already aborted at call time', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new StubProvider(async ({ signal }) => {
      if (signal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }
      return okResult();
    });

    const result = await sideQuery({
      provider, model: 'm', system: 's',
      messages: baseMessages, querySource: 'auto_mode',
      abortSignal: controller.signal,
    });

    expect(result.stopReason).toBe('aborted');
  });

  it('returns error stopReason when provider throws non-abort error', async () => {
    const provider = new StubProvider(async () => {
      throw new Error('synthetic provider failure');
    });

    const result = await sideQuery({
      provider, model: 'm', system: 's',
      messages: baseMessages, querySource: 'auto_mode',
    });

    expect(result.stopReason).toBe('error');
    expect(result.error?.message).toMatch(/synthetic/);
    expect(result.text).toBe('');
  });

  it('never throws — all failure paths produce a result', async () => {
    const provider = new StubProvider(async () => {
      throw new Error('boom');
    });

    // No try/catch around sideQuery — if it throws, this test fails.
    const result = await sideQuery({
      provider, model: 'm', system: 's',
      messages: baseMessages, querySource: 'auto_mode',
    });

    expect(result).toBeDefined();
    expect(result.stopReason).toBe('error');
  });
});

describe('sideQuery — message isolation', () => {
  it('passes a copy of messages to provider (no shared array reference)', async () => {
    const provider = new StubProvider(async () => okResult());
    const messages: KodaXMessage[] = [{ role: 'user', content: 'hi' }];

    await sideQuery({
      provider, model: 'm', system: 's',
      messages,
      querySource: 'auto_mode',
    });

    const passed = provider.capturedCalls[0]!.messages;
    expect(passed).toEqual(messages);
    expect(passed).not.toBe(messages); // different array reference
  });
});
