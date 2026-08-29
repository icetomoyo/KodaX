import { describe, expect, it } from 'vitest';
import { sideQuery } from './side-query.js';
import { KodaXBaseProvider } from './providers/base.js';
import { createCostTracker } from './cost-tracker.js';
import {
  createProviderCredentialLeaseScope,
  runWithProviderCredentialLeaseScope,
} from './provider-credential-context.js';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningProfile,
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

  constructor(
    private readonly streamImpl: StreamImpl,
    private readonly reasoningProfile?: KodaXReasoningProfile,
  ) {
    super();
  }

  override getReasoningProfile(): KodaXReasoningProfile | undefined {
    return this.reasoningProfile ?? super.getReasoningProfile();
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

class ThrowingProfileProvider extends StubProvider {
  override getReasoningProfile(): KodaXReasoningProfile | undefined {
    throw new Error('reasoning profile unavailable');
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

  it.each([
    { requested: 'workflow' as const, expected: 'workflow' },
    { requested: undefined, expected: 'utility' },
  ])('reports the $expected credential purpose to a lazy broker', async ({ requested, expected }) => {
    const purposes: string[] = [];
    const provider = new StubProvider(async () => okResult());
    const scope = createProviderCredentialLeaseScope({
      allowedProviders: ['stub'],
      async acquire(_provider, purpose) {
        purposes.push(purpose);
        return 'stub-secret';
      },
    });

    const result = await runWithProviderCredentialLeaseScope(scope, () => sideQuery({
      provider,
      model: 'stub-default',
      system: 'sys',
      messages: baseMessages,
      querySource: 'purpose-test',
      ...(requested === undefined ? {} : { credentialPurpose: requested }),
    }));

    expect(result.stopReason).toBe('end_turn');
    expect(purposes).toEqual([expected]);
    scope.close();
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
    expect(call.reasoning).toEqual({ effort: 'none' });
  });

  it('honors caller-provided reasoning override', async () => {
    const provider = new StubProvider(async () => okResult());

    await sideQuery({
      provider,
      model: 'm',
      system: 's',
      messages: baseMessages,
      querySource: 'auto_mode',
      reasoning: { effort: 'high' },
    });

    expect(provider.capturedCalls[0]!.reasoning).toEqual({ effort: 'high' });
  });

  it('uses the lowest visible effort when the model cannot disable thinking', async () => {
    const provider = new StubProvider(async () => okResult(), {
      effortStrategy: 'openai-chat-effort',
      defaultEffort: 'medium',
      supportedEfforts: [
        { value: 'low' },
        { value: 'medium', isDefault: true },
        { value: 'high' },
      ],
      localRejectEfforts: ['none', 'minimal'],
    });

    await sideQuery({
      provider,
      model: 'always-on-model',
      system: 'sys',
      messages: baseMessages,
      querySource: 'auto_mode',
    });

    expect(provider.capturedCalls[0]!.reasoning).toEqual({ effort: 'low' });
  });

  it('reserves a valid final-answer window for an always-on budget model', async () => {
    const provider = new StubProvider(async () => okResult(), {
      effortStrategy: 'provider-budget',
      thinkingStrategy: 'provider-budget',
      defaultEffort: 'medium',
      supportedEfforts: [
        { value: 'low' },
        { value: 'medium', isDefault: true },
        { value: 'high' },
      ],
      budgetByEffort: { low: 6000 },
      localRejectEfforts: ['none', 'minimal'],
      supportsManualThinkingBudget: true,
      supportsDisabledThinking: false,
    });

    await sideQuery({
      provider,
      model: 'always-on-budget-model',
      system: 'sys',
      messages: baseMessages,
      querySource: 'auto_mode',
      maxOutputTokens: 256,
    });

    const call = provider.capturedCalls[0]!;
    expect(call.reasoning).toEqual({ effort: 'low' });
    expect(call.streamOptions?.maxOutputTokensOverride).toBe(1280);
  });

  it('reserves the same bounded window for an always-on effort model', async () => {
    const provider = new StubProvider(async () => okResult(), {
      effortStrategy: 'prompt-only',
      defaultEffort: 'high',
      supportedEfforts: [
        { value: 'low' },
        { value: 'high', isDefault: true },
      ],
      localRejectEfforts: ['none', 'minimal'],
    });

    await sideQuery({
      provider,
      model: 'always-on-effort-model',
      system: 'sys',
      messages: baseMessages,
      querySource: 'auto_mode',
      maxOutputTokens: 256,
    });

    const call = provider.capturedCalls[0]!;
    expect(call.reasoning).toEqual({ effort: 'low' });
    expect(call.streamOptions?.maxOutputTokensOverride).toBe(1280);
  });

  it('uses the lowest enabled effort when none aliases to an always-on effort', async () => {
    const provider = new StubProvider(async () => okResult(), {
      effortStrategy: 'openai-chat-effort',
      thinkingStrategy: 'provider-toggle',
      defaultEffort: 'low',
      supportedEfforts: [
        { value: 'none' },
        { value: 'low', isDefault: true },
        { value: 'high' },
      ],
      effortAliases: { none: 'low' },
      disabledEfforts: ['none'],
      supportsDisabledThinking: false,
    });

    await sideQuery({
      provider,
      model: 'always-on-aliased-model',
      system: 'sys',
      messages: baseMessages,
      querySource: 'auto_mode',
      maxOutputTokens: 256,
    });

    const call = provider.capturedCalls[0]!;
    expect(call.reasoning).toEqual({ effort: 'low' });
    expect(call.streamOptions?.maxOutputTokensOverride).toBe(1280);
  });

  it('keeps the legacy visible-none default when disable support is unspecified', async () => {
    const provider = new StubProvider(async () => okResult(), {
      effortStrategy: 'openai-chat-effort',
      supportedEfforts: [
        { value: 'none' },
        { value: 'low' },
      ],
    });

    await sideQuery({
      provider,
      model: 'legacy-toggle-model',
      system: 'sys',
      messages: baseMessages,
      querySource: 'auto_mode',
      maxOutputTokens: 256,
    });

    const call = provider.capturedCalls[0]!;
    expect(call.reasoning).toEqual({ effort: 'none' });
    expect(call.streamOptions?.maxOutputTokensOverride).toBe(256);
  });

  it.each([
    {
      name: 'missing efforts',
      profile: {
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        supportsDisabledThinking: false,
      },
    },
    {
      name: 'empty efforts',
      profile: {
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        supportedEfforts: [],
        supportsDisabledThinking: false,
      },
    },
    {
      name: 'hidden efforts',
      profile: {
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        supportedEfforts: [
          { value: 'none' },
          { value: 'low', isUserVisible: false },
        ],
        supportsDisabledThinking: false,
      },
    },
    {
      name: 'rejected efforts',
      profile: {
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        supportedEfforts: [
          { value: 'none' },
          { value: 'low' },
        ],
        localRejectEfforts: ['low'],
        supportsDisabledThinking: false,
      },
    },
  ] satisfies readonly { name: string; profile: KodaXReasoningProfile }[])(
    'uses enabled auto for an always-on profile with $name',
    async ({ profile }) => {
      const provider = new StubProvider(async () => okResult(), profile);

      await sideQuery({
        provider,
        model: 'always-on-incomplete-profile',
        system: 'sys',
        messages: baseMessages,
        querySource: 'auto_mode',
        maxOutputTokens: 256,
      });

      const call = provider.capturedCalls[0]!;
      expect(call.reasoning).toEqual({ effort: 'auto' });
      expect(call.streamOptions?.maxOutputTokensOverride).toBe(1280);
    },
  );

  it('skips efforts whose raw or aliased meaning cannot enable thinking', async () => {
    const provider = new StubProvider(async () => okResult(), {
      effortStrategy: 'openai-chat-effort',
      thinkingStrategy: 'provider-toggle',
      supportedEfforts: [
        { value: 'none' },
        { value: 'low' },
        { value: 'medium' },
        { value: 'high' },
      ],
      effortAliases: { low: 'blocked' },
      disabledEfforts: ['none', 'medium'],
      localRejectEfforts: ['blocked'],
      supportsDisabledThinking: false,
    });

    await sideQuery({
      provider,
      model: 'always-on-filtered-model',
      system: 'sys',
      messages: baseMessages,
      querySource: 'auto_mode',
      maxOutputTokens: 256,
    });

    const call = provider.capturedCalls[0]!;
    expect(call.reasoning).toEqual({ effort: 'high' });
    expect(call.streamOptions?.maxOutputTokensOverride).toBe(1280);
  });

  it('preserves an explicit reasoning request and output cap', async () => {
    const provider = new StubProvider(async () => okResult(), {
      effortStrategy: 'provider-budget',
      thinkingStrategy: 'provider-budget',
      defaultEffort: 'medium',
      supportedEfforts: [
        { value: 'low' },
        { value: 'medium', isDefault: true },
        { value: 'high' },
      ],
      budgetByEffort: { low: 6000, medium: 10000, high: 20000 },
      localRejectEfforts: ['none', 'minimal'],
      supportsManualThinkingBudget: true,
      supportsDisabledThinking: false,
    });

    await sideQuery({
      provider,
      model: 'always-on-explicit-model',
      system: 'sys',
      messages: baseMessages,
      querySource: 'auto_mode',
      reasoning: { effort: 'high' },
      maxOutputTokens: 256,
    });

    const call = provider.capturedCalls[0]!;
    expect(call.reasoning).toEqual({ effort: 'high' });
    expect(call.streamOptions?.maxOutputTokensOverride).toBe(256);
  });

  it('uses none when the profile declares a disabled effort', async () => {
    const provider = new StubProvider(async () => okResult(), {
      effortStrategy: 'provider-budget',
      supportedEfforts: [
        { value: 'none' },
        { value: 'low' },
        { value: 'medium', isDefault: true },
      ],
      disabledEfforts: ['none'],
      supportsDisabledThinking: true,
    });

    await sideQuery({
      provider,
      model: 'hybrid-thinking-model',
      system: 'sys',
      messages: baseMessages,
      querySource: 'auto_mode',
    });

    expect(provider.capturedCalls[0]!.reasoning).toEqual({ effort: 'none' });
  });

  it('preserves an explicit none request so strict callers still see rejection', async () => {
    const provider = new StubProvider(async () => okResult(), {
      effortStrategy: 'openai-chat-effort',
      supportedEfforts: [{ value: 'low' }, { value: 'high' }],
      localRejectEfforts: ['none', 'minimal'],
    });

    await sideQuery({
      provider,
      model: 'always-on-model',
      system: 'sys',
      messages: baseMessages,
      querySource: 'workflow',
      reasoning: { effort: 'none' },
    });

    expect(provider.capturedCalls[0]!.reasoning).toEqual({ effort: 'none' });
  });

  it('forwards a valid per-request output-token cap without mutating provider state', async () => {
    const provider = new StubProvider(async () => okResult());

    await sideQuery({
      provider,
      model: 'm',
      system: 's',
      messages: baseMessages,
      querySource: 'auto_mode',
      maxOutputTokens: 256,
    });

    expect(provider.capturedCalls[0]!.streamOptions?.maxOutputTokensOverride).toBe(256);
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

  it('maps OpenAI-compatible length truncation to max_tokens', async () => {
    const provider = new StubProvider(async () => okResult({
      textBlocks: [text('truncated...')],
      stopReason: 'length',
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

  it('records provider retry waits through streamOptions.onRetryAfter', async () => {
    const provider = new StubProvider(async ({ streamOptions }) => {
      expect(streamOptions?.onRetryAfter).toBeTypeOf('function');
      streamOptions?.onRetryAfter?.({
        provider: 'stub',
        waitMs: 250,
        reason: 'rate-limit',
        source: 'retry-after-ms',
        attempt: 1,
        maxAttempts: 3,
      });
      return okResult();
    });

    const result = await sideQuery({
      provider,
      model: 'stub-default',
      system: 'sys',
      messages: baseMessages,
      querySource: 'auto_mode',
      costTracker: createCostTracker(),
    });

    expect(result.costTracker?.retries).toHaveLength(1);
    expect(result.costTracker?.retries[0]).toMatchObject({
      provider: 'stub',
      waitMs: 250,
      reason: 'rate-limit',
      source: 'retry-after-ms',
    });
    expect(result.diagnostics).toMatchObject({
      provider: 'stub',
      model: 'stub-default',
      timeoutMs: 30_000,
      systemBytes: Buffer.byteLength('sys', 'utf8'),
      messageBytes: Buffer.byteLength(JSON.stringify(baseMessages), 'utf8'),
      retryCount: 1,
      retryWaitMs: 250,
      terminalPhase: 'completed',
      stopReason: 'end_turn',
      responseBytes: Buffer.byteLength('ok', 'utf8'),
      textBlockCount: 1,
    });
    expect(result.diagnostics?.promptBytes).toBe(
      result.diagnostics!.systemBytes + result.diagnostics!.messageBytes,
    );
    expect(result.diagnostics?.elapsedMs).toBeGreaterThanOrEqual(0);
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
    expect(result.diagnostics).toMatchObject({
      provider: 'stub',
      model: 'm',
      timeoutMs: 20,
      retryCount: 0,
      retryWaitMs: 0,
      terminalPhase: 'pre_output',
    });
  });

  it('enforces its deadline even when the provider ignores AbortSignal', async () => {
    const provider = new StubProvider(async () => (
      new Promise<KodaXStreamResult>((resolve) => {
        setTimeout(() => resolve(okResult()), 100);
      })
    ));
    const startedAt = performance.now();

    const result = await sideQuery({
      provider, model: 'm', system: 's',
      messages: baseMessages, querySource: 'auto_mode',
      timeoutMs: 10,
    });

    expect(result.stopReason).toBe('timeout');
    expect(performance.now() - startedAt).toBeLessThan(80);
    expect(result.diagnostics?.terminalPhase).toBe('pre_output');
  });

  it('reports whether a timeout happened after streaming began', async () => {
    const provider = new StubProvider(async ({ streamOptions, signal }) => {
      streamOptions?.onTextDelta?.('partial');
      return new Promise<KodaXStreamResult>((_, reject) => {
        signal!.addEventListener(
          'abort',
          () => reject(new DOMException('Request aborted', 'AbortError')),
          { once: true },
        );
      });
    });

    const result = await sideQuery({
      provider,
      model: 'm',
      system: 's',
      messages: baseMessages,
      querySource: 'auto_mode',
      timeoutMs: 20,
    });

    expect(result.stopReason).toBe('timeout');
    expect(result.diagnostics?.terminalPhase).toBe('streaming');
    expect(result.diagnostics?.firstOutputMs).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics?.streamMs).toBeGreaterThanOrEqual(0);
  });

  it('distinguishes an upstream lifecycle event and thinking from first text output', async () => {
    const provider = new StubProvider(async ({ streamOptions, signal }) => {
      streamOptions?.onHeartbeat?.();
      streamOptions?.onThinkingDelta?.('checking policy');
      return new Promise<KodaXStreamResult>((_, reject) => {
        signal!.addEventListener(
          'abort',
          () => reject(new DOMException('Request aborted', 'AbortError')),
          { once: true },
        );
      });
    });

    const result = await sideQuery({
      provider,
      model: 'm',
      system: 's',
      messages: baseMessages,
      querySource: 'auto_mode',
      timeoutMs: 20,
    });

    expect(result.stopReason).toBe('timeout');
    expect(result.diagnostics?.terminalPhase).toBe('thinking');
    expect(result.diagnostics?.firstUpstreamEventMs).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics?.firstThinkingDeltaMs).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics?.firstTextDeltaMs).toBeUndefined();
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

  it('contains reasoning-profile resolution failures inside the result contract', async () => {
    const provider = new ThrowingProfileProvider(async () => okResult());

    const result = await sideQuery({
      provider,
      model: 'm',
      system: 's',
      messages: baseMessages,
      querySource: 'auto_mode',
      maxOutputTokens: 256,
    });

    expect(result.stopReason).toBe('error');
    expect(result.error?.message).toBe('reasoning profile unavailable');
    expect(result.diagnostics?.terminalPhase).toBe('pre_output');
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
