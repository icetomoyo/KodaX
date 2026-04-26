/**
 * Smoke tests for tests/sa-refactor-goldens/providers.ts
 *
 * Two non-negotiable invariants:
 *   1. Recorded callback timeline replays in identical order with identical
 *      payloads (any drift = the goldens harness has lied about behaviour).
 *   2. Shape divergence at replay time fails loudly with a structured diff
 *      pointing at the offending field (so a regression surfaces on the
 *      first diverging call, not on a downstream cascade).
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';

import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax/ai';
import { KodaXBaseProvider } from '@kodax/ai';

import {
  RecorderProvider,
  ReplayProvider,
  ReplayMismatchError,
  ReplayExhaustedError,
  diffEnvelope,
} from './providers.js';

// ---------------------------------------------------------------------------
// Fake inner provider — emits a scripted callback timeline + result
// ---------------------------------------------------------------------------

interface ScriptedTurn {
  callbacks: Array<
    | { kind: 'textDelta'; text: string }
    | { kind: 'thinkingDelta'; text: string }
    | { kind: 'thinkingEnd'; thinking: string }
    | { kind: 'toolInputDelta'; toolName: string; partialJson: string; toolId?: string }
    | { kind: 'rateLimit'; attempt: number; maxRetries: number; delayMs: number }
    | { kind: 'heartbeat'; pause?: boolean }
  >;
  result: KodaXStreamResult;
}

class ScriptedProvider extends KodaXBaseProvider {
  readonly name: string = 'scripted';
  readonly supportsThinking: boolean = true;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: '__SCRIPTED_NO_KEY__',
    model: 'scripted-model',
    supportsThinking: true,
    reasoningCapability: 'native-budget',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  };

  private readonly turns: ScriptedTurn[];
  private cursor = 0;

  constructor(turns: ScriptedTurn[]) {
    super();
    this.turns = turns;
  }

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    if (this.cursor >= this.turns.length) {
      throw new Error('ScriptedProvider exhausted');
    }
    const turn = this.turns[this.cursor++]!;
    for (const cb of turn.callbacks) {
      switch (cb.kind) {
        case 'textDelta':
          streamOptions?.onTextDelta?.(cb.text);
          break;
        case 'thinkingDelta':
          streamOptions?.onThinkingDelta?.(cb.text);
          break;
        case 'thinkingEnd':
          streamOptions?.onThinkingEnd?.(cb.thinking);
          break;
        case 'toolInputDelta':
          streamOptions?.onToolInputDelta?.(
            cb.toolName,
            cb.partialJson,
            cb.toolId !== undefined ? { toolId: cb.toolId } : undefined,
          );
          break;
        case 'rateLimit':
          streamOptions?.onRateLimit?.(cb.attempt, cb.maxRetries, cb.delayMs);
          break;
        case 'heartbeat':
          streamOptions?.onHeartbeat?.(cb.pause);
          break;
      }
    }
    return turn.result;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAIN_MESSAGES: KodaXMessage[] = [
  { role: 'user', content: 'hello' },
];

const TOOL_MESSAGES: KodaXMessage[] = [
  { role: 'user', content: 'use a tool' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'calling read' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '...file content...' }],
  },
];

const TOOLS: KodaXToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

const RESULT_TEXT_ONLY: KodaXStreamResult = {
  textBlocks: [{ type: 'text', text: 'hi back' }],
  toolBlocks: [],
  thinkingBlocks: [],
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  stopReason: 'end_turn',
};

const RESULT_TOOL_USE: KodaXStreamResult = {
  textBlocks: [{ type: 'text', text: 'using tool' }],
  toolBlocks: [
    { type: 'tool_use', id: 'call_2', name: 'read_file', input: { path: 'b.ts' } },
  ],
  thinkingBlocks: [],
  usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
  stopReason: 'tool_use',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecorderProvider', () => {
  it('captures the full callback timeline + result + delegates to inner provider', async () => {
    const inner = new ScriptedProvider([
      {
        callbacks: [
          { kind: 'heartbeat' },
          { kind: 'thinkingDelta', text: 'thinking...' },
          { kind: 'thinkingEnd', thinking: 'thinking...' },
          { kind: 'textDelta', text: 'hi' },
          { kind: 'textDelta', text: ' back' },
        ],
        result: RESULT_TEXT_ONLY,
      },
    ]);

    const recorder = new RecorderProvider(inner, 'session-A');
    const onText = vi.fn();
    const onHeartbeat = vi.fn();
    const onThinkingEnd = vi.fn();

    const result = await recorder.stream(
      PLAIN_MESSAGES,
      [],
      'You are a helpful assistant.',
      undefined,
      { onTextDelta: onText, onHeartbeat, onThinkingEnd },
    );

    expect(result).toBe(RESULT_TEXT_ONLY);
    expect(onText).toHaveBeenCalledTimes(2);
    expect(onText).toHaveBeenNthCalledWith(1, 'hi');
    expect(onText).toHaveBeenNthCalledWith(2, ' back');
    expect(onHeartbeat).toHaveBeenCalledTimes(1);
    expect(onThinkingEnd).toHaveBeenCalledWith('thinking...');

    const recording = recorder.buildRecording();
    expect(recording.formatVersion).toBe(1);
    expect(recording.sessionId).toBe('session-A');
    expect(recording.innerProvider).toBe('scripted');
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]!.callbacks).toHaveLength(5);
    expect(recording.calls[0]!.request.messageCount).toBe(1);
    expect(recording.calls[0]!.request.toolNames).toEqual([]);
  });

  it('delegates KodaXBaseProvider config queries to the inner provider', () => {
    const inner = new ScriptedProvider([]);
    const recorder = new RecorderProvider(inner, 'session-cfg');

    expect(recorder.getModel()).toBe(inner.getModel());
    expect(recorder.getAvailableModels()).toEqual(inner.getAvailableModels());
    expect(recorder.getApiKeyEnv()).toBe(inner.getApiKeyEnv());
    expect(recorder.getEffectiveContextWindow()).toBe(inner.getEffectiveContextWindow());
    expect(recorder.getEffectiveMaxOutputTokens()).toBe(inner.getEffectiveMaxOutputTokens());
    expect(recorder.getReasoningCapability()).toBe(inner.getReasoningCapability());
    expect(recorder.isConfigured()).toBe(inner.isConfigured());
  });

  it('routes setMaxOutputTokensOverride to the inner provider so escalation works during recording', () => {
    const inner = new ScriptedProvider([]);
    const recorder = new RecorderProvider(inner, 'session-esc');

    recorder.setMaxOutputTokensOverride(99_000);
    expect(inner.getEffectiveMaxOutputTokens()).toBe(99_000);
    expect(recorder.getEffectiveMaxOutputTokens()).toBe(99_000);
    recorder.setMaxOutputTokensOverride(undefined);
    expect(inner.getEffectiveMaxOutputTokens()).toBe(32_000);
  });

  it('captures innerSummary in the recording for replay-side delegation', async () => {
    const inner = new ScriptedProvider([
      { callbacks: [], result: RESULT_TEXT_ONLY },
    ]);
    const recorder = new RecorderProvider(inner, 'session-summary');
    await recorder.stream(PLAIN_MESSAGES, [], 'sys', undefined, {});

    const recording = recorder.buildRecording();
    expect(recording.innerSummary.defaultModel).toBe('scripted-model');
    expect(recording.innerSummary.contextWindow).toBe(200_000);
    expect(recording.innerSummary.maxOutputTokens).toBe(32_000);
    expect(recording.innerSummary.reasoningCapability).toBe('native-budget');
    expect(recording.innerSummary.supportsThinking).toBe(true);
  });

  it('persists recordings to disk in <dir>/<sessionId>.json', async () => {
    const inner = new ScriptedProvider([
      { callbacks: [{ kind: 'textDelta', text: 'ok' }], result: RESULT_TEXT_ONLY },
    ]);
    const recorder = new RecorderProvider(inner, 'session-B');
    await recorder.stream(PLAIN_MESSAGES, [], 'system', undefined, {});

    const dir = await fs.mkdtemp(path.join(tmpdir(), 'kodax-goldens-'));
    try {
      const filePath = await recorder.writeTo(dir);
      expect(filePath.endsWith('session-B.json')).toBe(true);
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.sessionId).toBe('session-B');
      expect(parsed.formatVersion).toBe(1);
      expect(parsed.calls).toHaveLength(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ReplayProvider', () => {
  it('replays recorded callbacks + result when shapes match', async () => {
    const inner = new ScriptedProvider([
      {
        callbacks: [
          { kind: 'thinkingDelta', text: 'planning' },
          { kind: 'thinkingEnd', thinking: 'planning' },
          { kind: 'toolInputDelta', toolName: 'read_file', partialJson: '{"pa', toolId: 'call_2' },
          { kind: 'toolInputDelta', toolName: 'read_file', partialJson: 'th":"b.ts"}', toolId: 'call_2' },
        ],
        result: RESULT_TOOL_USE,
      },
    ]);
    const recorder = new RecorderProvider(inner, 'session-C');
    await recorder.stream(TOOL_MESSAGES, TOOLS, 'sys-prompt', { enabled: true, depth: 'medium' }, {});

    const replay = new ReplayProvider(recorder.buildRecording());
    expect(replay.remaining).toBe(1);

    const onThinkingDelta = vi.fn();
    const onThinkingEnd = vi.fn();
    const onToolInputDelta = vi.fn();

    const result = await replay.stream(
      TOOL_MESSAGES,
      TOOLS,
      'sys-prompt',
      { enabled: true, depth: 'medium' },
      { onThinkingDelta, onThinkingEnd, onToolInputDelta },
    );

    expect(result).toEqual(RESULT_TOOL_USE);
    expect(onThinkingDelta).toHaveBeenCalledWith('planning');
    expect(onThinkingEnd).toHaveBeenCalledWith('planning');
    expect(onToolInputDelta).toHaveBeenCalledTimes(2);
    expect(onToolInputDelta).toHaveBeenNthCalledWith(1, 'read_file', '{"pa', { toolId: 'call_2' });
    expect(onToolInputDelta).toHaveBeenNthCalledWith(2, 'read_file', 'th":"b.ts"}', { toolId: 'call_2' });

    expect(replay.remaining).toBe(0);
  });

  it('throws ReplayMismatchError on message-count drift', async () => {
    const inner = new ScriptedProvider([
      { callbacks: [{ kind: 'textDelta', text: 'ok' }], result: RESULT_TEXT_ONLY },
    ]);
    const recorder = new RecorderProvider(inner, 'session-D');
    await recorder.stream(PLAIN_MESSAGES, [], 'sys', undefined, {});

    const replay = new ReplayProvider(recorder.buildRecording());

    const live: KodaXMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'leaked extra turn' },
    ];

    await expect(replay.stream(live, [], 'sys', undefined, {})).rejects.toBeInstanceOf(
      ReplayMismatchError,
    );
  });

  it('throws ReplayMismatchError on tool-name drift', async () => {
    const inner = new ScriptedProvider([
      { callbacks: [], result: RESULT_TEXT_ONLY },
    ]);
    const recorder = new RecorderProvider(inner, 'session-E');
    await recorder.stream(PLAIN_MESSAGES, TOOLS, 'sys', undefined, {});

    const replay = new ReplayProvider(recorder.buildRecording());

    const otherTools: KodaXToolDefinition[] = [
      {
        name: 'write_file',
        description: 'Write a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ];

    await expect(
      replay.stream(PLAIN_MESSAGES, otherTools, 'sys', undefined, {}),
    ).rejects.toMatchObject({
      name: 'ReplayMismatchError',
      diffs: expect.arrayContaining([
        expect.objectContaining({ field: 'toolNames' }),
      ]),
    });
  });

  it('throws ReplayExhaustedError when stream() is called past recording length', async () => {
    const inner = new ScriptedProvider([
      { callbacks: [], result: RESULT_TEXT_ONLY },
    ]);
    const recorder = new RecorderProvider(inner, 'session-F');
    await recorder.stream(PLAIN_MESSAGES, [], 'sys', undefined, {});

    const replay = new ReplayProvider(recorder.buildRecording());
    await replay.stream(PLAIN_MESSAGES, [], 'sys', undefined, {});

    await expect(
      replay.stream(PLAIN_MESSAGES, [], 'sys', undefined, {}),
    ).rejects.toBeInstanceOf(ReplayExhaustedError);
  });

  it('rejects unsupported formatVersion', () => {
    // Fixture deliberately violates the formatVersion: 1 literal type to test
    // the runtime guard. Cast through `as never` to bypass the static check.
    const bogus = {
      formatVersion: 99,
      sessionId: 'x',
      recordedAt: '',
      innerProvider: 'x',
      innerModel: 'x',
      innerSummary: {
        name: 'x',
        supportsThinking: true,
        apiKeyEnv: 'X',
        defaultModel: 'm',
        availableModels: ['m'],
        capabilityProfile: { transport: 'native-api', conversationSemantics: 'full-history', mcpSupport: 'native' },
        reasoningCapability: 'none' as const,
        contextWindow: 100,
        maxOutputTokens: 100,
        supportsNonStreamingFallback: false,
        isConfigured: true,
      },
      calls: [],
    } as never;
    expect(() => new ReplayProvider(bogus)).toThrow(/formatVersion/);
  });

  it('serves config queries from captured innerSummary, not WRAPPER_CONFIG defaults', async () => {
    // Inner provider with non-default values — proves delegation, not coincidence.
    class CustomScripted extends ScriptedProvider {
      override readonly name = 'custom-scripted';
      override readonly supportsThinking = false;
      protected override readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'CUSTOM_KEY',
        baseUrl: 'https://custom.example.com',
        model: 'custom-default-model',
        models: [{ id: 'custom-default-model' }, { id: 'alt-model', contextWindow: 8_000 }],
        supportsThinking: false,
        reasoningCapability: 'none',
        contextWindow: 80_000,
        maxOutputTokens: 4_000,
      };
    }

    const inner = new CustomScripted([{ callbacks: [], result: RESULT_TEXT_ONLY }]);
    const recorder = new RecorderProvider(inner, 'session-delegation');
    await recorder.stream(PLAIN_MESSAGES, [], 'sys', undefined, {});

    const replay = new ReplayProvider(recorder.buildRecording());
    expect(replay.getModel()).toBe('custom-default-model');
    expect(replay.getApiKeyEnv()).toBe('CUSTOM_KEY');
    expect(replay.getBaseUrl()).toBe('https://custom.example.com');
    expect(replay.getEffectiveContextWindow()).toBe(80_000);
    expect(replay.getEffectiveMaxOutputTokens()).toBe(4_000);
    expect(replay.getReasoningCapability()).toBe('none');
    expect(replay.supportsThinking).toBe(false);
    expect(replay.getAvailableModels()).toEqual(['custom-default-model', 'alt-model']);
  });

  it('honours setMaxOutputTokensOverride during replay (one-shot escalation)', async () => {
    const inner = new ScriptedProvider([{ callbacks: [], result: RESULT_TEXT_ONLY }]);
    const recorder = new RecorderProvider(inner, 'session-replay-esc');
    await recorder.stream(PLAIN_MESSAGES, [], 'sys', undefined, {});

    const replay = new ReplayProvider(recorder.buildRecording());
    expect(replay.getEffectiveMaxOutputTokens()).toBe(32_000);
    replay.setMaxOutputTokensOverride(64_000);
    expect(replay.getEffectiveMaxOutputTokens()).toBe(64_000);
    replay.setMaxOutputTokensOverride(undefined);
    expect(replay.getEffectiveMaxOutputTokens()).toBe(32_000);
  });

  it('rejects recordings missing innerSummary', () => {
    // Fixture deliberately violates the type — old recordings won't have the
    // field, but the constructor should reject them rather than silently
    // serve undefined config values.
    const bogus = {
      formatVersion: 1,
      sessionId: 'x',
      recordedAt: '',
      innerProvider: 'x',
      innerModel: 'x',
      calls: [],
    } as never;
    expect(() => new ReplayProvider(bogus)).toThrow(/innerSummary/);
  });

  it('round-trips through disk: writeTo → fromFile → replay', async () => {
    const inner = new ScriptedProvider([
      { callbacks: [{ kind: 'textDelta', text: 'persisted' }], result: RESULT_TEXT_ONLY },
    ]);
    const recorder = new RecorderProvider(inner, 'session-G');
    await recorder.stream(PLAIN_MESSAGES, [], 'sys', undefined, {});

    const dir = await fs.mkdtemp(path.join(tmpdir(), 'kodax-goldens-'));
    try {
      const filePath = await recorder.writeTo(dir);
      const replay = await ReplayProvider.fromFile(filePath);

      const onText = vi.fn();
      const result = await replay.stream(PLAIN_MESSAGES, [], 'sys', undefined, { onTextDelta: onText });

      expect(result).toEqual(RESULT_TEXT_ONLY);
      expect(onText).toHaveBeenCalledWith('persisted');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('diffEnvelope', () => {
  it('returns [] when shapes match', () => {
    const a = {
      messageCount: 1,
      messageShape: [{ role: 'user' as const, contentKind: 'string' as const }],
      toolNames: [],
      systemLength: 5,
      reasoning: null,
    };
    expect(diffEnvelope(a, a)).toEqual([]);
  });

  it('catches block-type drift inside structured content', () => {
    const recorded = {
      messageCount: 1,
      messageShape: [
        {
          role: 'assistant' as const,
          contentKind: 'blocks' as const,
          blockTypes: ['text', 'tool_use'],
        },
      ],
      toolNames: [],
      systemLength: 5,
      reasoning: null,
    };
    const live = {
      messageCount: 1,
      messageShape: [
        {
          role: 'assistant' as const,
          contentKind: 'blocks' as const,
          blockTypes: ['text'],
        },
      ],
      toolNames: [],
      systemLength: 5,
      reasoning: null,
    };
    const diffs = diffEnvelope(recorded, live);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.field).toBe('messageShape[0].blockTypes');
  });
});
