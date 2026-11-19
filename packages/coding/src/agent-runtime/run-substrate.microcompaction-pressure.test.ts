import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return { ...actual, compact: vi.fn() };
});

import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import { compact as mockedCompact } from '@kodax-ai/agent';

import { runTestSubstrate as runSubstrate } from './test-leaf.js';

const compactMock = mockedCompact as unknown as ReturnType<typeof vi.fn>;

const PROVIDER_NAME = 'microcompaction-pressure-test';
const API_KEY_ENV = 'MICROCOMPACTION_PRESSURE_TEST_API_KEY';

class CaptureProvider extends KodaXBaseProvider {
  static calls: KodaXMessage[][] = [];

  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: API_KEY_ENV,
    model: 'capture-model',
    supportsThinking: false,
    contextWindow: 1_000_000,
    maxOutputTokens: 1_000,
  };

  async stream(
    messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
  ): Promise<KodaXStreamResult> {
    CaptureProvider.calls.push(messages);
    return {
      textBlocks: [{ type: 'text', text: 'done' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 20, outputTokens: 1, totalTokens: 21 },
    };
  }
}

function agedToolResult(content: string): KodaXMessage[] {
  const messages: KodaXMessage[] = [
    {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'old-read',
        name: 'read',
        input: { path: 'important.ts' },
      }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'old-read',
        content,
      }],
    },
  ];
  for (let turn = 0; turn < 25; turn += 1) {
    messages.push({ role: 'assistant', content: `reply ${turn}` });
    messages.push({ role: 'user', content: `follow-up ${turn}` });
  }
  return messages;
}

function oldResultFrom(messages: KodaXMessage[]): string | undefined {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.tool_use_id === 'old-read') {
        return typeof block.content === 'string' ? block.content : undefined;
      }
    }
  }
  return undefined;
}

function capturedOldResult(): string | undefined {
  return oldResultFrom(CaptureProvider.calls.at(-1) ?? []);
}

describe('runSubstrate pressure-gated microcompaction', { timeout: 15_000 }, () => {
  beforeEach(() => {
    CaptureProvider.calls = [];
    compactMock.mockReset();
    compactMock.mockImplementation(async (messages: KodaXMessage[]) => ({
      compacted: true,
      messages: [{ role: 'system', content: '[对话历史摘要]\n\nsemantic summary' }],
      summary: 'semantic summary',
      tokensBefore: 60_000,
      tokensAfter: 100,
      entriesRemoved: messages.length,
    }));
    process.env[API_KEY_ENV] = 'test-key';
    registerModelProvider(PROVIDER_NAME, () => new CaptureProvider());
  });

  afterEach(() => {
    clearRuntimeModelProviders();
    delete process.env[API_KEY_ENV];
  });

  it('preserves aged tool results when the current turn is below compaction pressure', async () => {
    const original = 'evidence that remains useful';

    await runSubstrate({
      provider: PROVIDER_NAME,
      model: 'capture-model',
      reasoningMode: 'off',
      maxIter: 1,
      compaction: { contextWindow: 1_000_000, triggerPercent: 80 },
      session: { initialMessages: agedToolResult(original) },
    }, 'continue');

    expect(CaptureProvider.calls).toHaveLength(1);
    expect(capturedOldResult()).toBe(original);
    expect(compactMock).not.toHaveBeenCalled();
  });

  it('gives semantic compaction the complete aged tool result under physical pressure', async () => {
    const oversized = `RAW_SENTINEL\n${'historical output '.repeat(12_000)}`;

    await runSubstrate({
      provider: PROVIDER_NAME,
      model: 'capture-model',
      reasoningMode: 'off',
      maxIter: 1,
      compaction: { contextWindow: 32_000, triggerPercent: 100 },
      session: { initialMessages: agedToolResult(oversized) },
    }, 'continue');

    expect(compactMock).toHaveBeenCalledOnce();
    const compactionInput = compactMock.mock.calls[0]?.[0] as KodaXMessage[] | undefined;
    expect(compactionInput).toBeDefined();
    expect(oldResultFrom(compactionInput ?? [])).toBe(oversized);
    expect(oldResultFrom(compactionInput ?? [])).not.toMatch(/^\[Cleared: /);
    expect(CaptureProvider.calls).toHaveLength(1);
    expect(capturedOldResult()).toBeUndefined();
  });
});
