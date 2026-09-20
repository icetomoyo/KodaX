import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';
import {
  setKodaXDiagnosticSink,
  type KodaXDiagnostic,
} from '@kodax-ai/agent';

import { runKodaX } from './agent.js';

const TEST_PROVIDER_NAME = 'stop-reason-scripted-provider';
const TEST_PROVIDER_API_KEY_ENV = 'STOP_REASON_SCRIPTED_PROVIDER_API_KEY';

class StopReasonScriptedProvider extends KodaXBaseProvider {
  static responses: KodaXStreamResult[] = [];
  static receivedMessages: KodaXMessage[][] = [];
  static streamCalls = 0;

  readonly name = TEST_PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: TEST_PROVIDER_API_KEY_ENV,
    model: 'stop-reason-test',
    supportsThinking: false,
    reasoningCapability: 'prompt-only',
    capabilityProfile: {
      transport: 'native-api',
      conversationSemantics: 'full-history',
      mcpSupport: 'none',
      contextFidelity: 'full',
      toolCallingFidelity: 'full',
      sessionSupport: 'stateless',
      longRunningSupport: 'limited',
      multimodalSupport: 'none',
      evidenceSupport: 'limited',
    },
  };

  async stream(
    messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    StopReasonScriptedProvider.receivedMessages.push([...messages]);
    const idx = StopReasonScriptedProvider.streamCalls;
    StopReasonScriptedProvider.streamCalls += 1;
    const streamResult = StopReasonScriptedProvider.responses[idx];
    if (!streamResult) {
      throw new Error(`No scripted stop-reason response for stream call #${idx + 1}`);
    }
    for (const block of streamResult.textBlocks) {
      streamOptions?.onTextDelta?.(block.text);
    }
    return streamResult;
  }
}

function resetProvider(): void {
  StopReasonScriptedProvider.responses = [];
  StopReasonScriptedProvider.receivedMessages = [];
  StopReasonScriptedProvider.streamCalls = 0;
}

function response(stopReason: string, text: string): KodaXStreamResult {
  return {
    textBlocks: text ? [{ type: 'text', text }] : [],
    toolBlocks: [],
    thinkingBlocks: [],
    stopReason,
  };
}

function syntheticMessageText(messages: readonly KodaXMessage[]): string {
  return messages
    .filter((message) => message.role === 'user' && message._synthetic === true)
    .map((message) => {
      if (typeof message.content === 'string') return message.content;
      return message.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
    })
    .join('\n');
}

describe('runKodaX stopReason normalization', () => {
  beforeEach(() => {
    resetProvider();
    process.env[TEST_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProvider(TEST_PROVIDER_NAME, () => new StopReasonScriptedProvider());
  });

  afterEach(() => {
    clearRuntimeModelProviders();
    delete process.env[TEST_PROVIDER_API_KEY_ENV];
    vi.restoreAllMocks();
  });

  it('continues pure-text output when OpenAI finish_reason=length', async () => {
    StopReasonScriptedProvider.responses = [
      response('length', 'first half'),
      response('end_turn', 'second half'),
    ];

    const textDeltas: string[] = [];
    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
        events: {
          onTextDelta: (text) => textDeltas.push(text),
        },
      },
      'Generate a long answer.',
    );

    expect(result.success).toBe(true);
    expect(StopReasonScriptedProvider.streamCalls).toBe(2);
    expect(textDeltas).toEqual(['first half', 'second half']);
  }, 30_000);

  it('auto-continues managed protocol when OpenAI finish_reason=stop', async () => {
    StopReasonScriptedProvider.responses = [
      response('stop', 'plain final text'),
      response('end_turn', 'still plain'),
    ];

    const segments: Array<{ responseId: string; mode: 'append' | 'replace' }> = [];
    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
        events: {
          onOutputSegmentStart: ({ responseId, mode }) => segments.push({ responseId, mode }),
        },
        context: {
          managedProtocolEmission: {
            enabled: true,
            role: 'evaluator',
          },
        },
      },
      'Evaluate.',
    );

    expect(result.success).toBe(true);
    expect(StopReasonScriptedProvider.streamCalls).toBe(2);
    expect(syntheticMessageText(result.messages)).toContain('required protocol was not emitted');
    expect(segments.map((segment) => segment.mode)).toEqual(['append', 'append']);
    expect(segments[1]?.responseId).toBe(segments[0]?.responseId);
  }, 30_000);

  it('treats pause_turn as a clean terminal without managed-protocol retry', async () => {
    StopReasonScriptedProvider.responses = [
      response('pause_turn', 'paused by provider'),
    ];

    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
        context: {
          managedProtocolEmission: {
            enabled: true,
            role: 'evaluator',
          },
        },
      },
      'Evaluate.',
    );

    expect(result.success).toBe(true);
    expect(StopReasonScriptedProvider.streamCalls).toBe(1);
    expect(syntheticMessageText(result.messages)).not.toContain('required protocol was not emitted');
  }, 30_000);

  it.each(['refusal', 'content_filter'])(
    'surfaces a decline note for %s without retrying',
    async (stopReason) => {
      StopReasonScriptedProvider.responses = [
        response(stopReason, ''),
      ];
      const textDeltas: string[] = [];
      const notices: string[] = [];

      const result = await runKodaX(
        {
          provider: TEST_PROVIDER_NAME,
          reasoningMode: 'off',
          events: {
            onTextDelta: (text) => textDeltas.push(text),
            onOutputNotice: notice => notices.push(notice.code),
          },
        },
        'Sensitive prompt.',
      );

      expect(result.success).toBe(true);
      expect(StopReasonScriptedProvider.streamCalls).toBe(1);
      expect(textDeltas.join('')).toBe('');
      expect(notices).toEqual(['model_refused']);
    },
    30_000,
  );

  it('warns once for unknown provider stop reasons and then terminates cleanly', async () => {
    StopReasonScriptedProvider.responses = [
      response('gateway_doneish', 'done'),
    ];
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));

    try {
      const result = await runKodaX(
        {
          provider: TEST_PROVIDER_NAME,
          modelOverride: 'gateway-model',
          reasoningMode: 'off',
        },
        'Answer.',
      );

      expect(result.success).toBe(true);
      const stopReasonDiagnostics = diagnostics.filter(
        (diagnostic) => diagnostic.source === 'coding:stop-reason',
      );
      expect(stopReasonDiagnostics).toHaveLength(1);
      expect(stopReasonDiagnostics[0]).toMatchObject({
        source: 'coding:stop-reason',
        level: 'warn',
        detail: {
          rawStopReason: 'gateway_doneish',
          provider: TEST_PROVIDER_NAME,
          model: 'gateway-model',
          hasToolBlocks: false,
          hasTextBlocks: true,
        },
      });
    } finally {
      restoreDiagnostics();
    }
  }, 30_000);
});
