/**
 * Max-tokens continuation tests.
 *
 * Covers the L5 recovery path for `stop_reason: max_tokens`:
 *  - When max_tokens hits and no tool_use was emitted, agent commits the
 *    (possibly empty) assistant and injects a Claude-Code-style meta
 *    message ("Break remaining work into smaller pieces"). Capped at
 *    KODAX_MAX_MAXTOKENS_RETRIES.
 *  - When max_tokens hits AND a tool_use was emitted (possibly salvaged
 *    via partial-json from a truncated stream), the agent commits and
 *    proceeds without a meta message — the tool execution + tool_result
 *    feedback loop carries the model forward naturally.
 *
 * The previous L1 escalation path (32K → 64K same-turn retry) was
 * removed in v0.7.29 after bench (kimi-code/mimo-coding/minimax-coding
 * M2.7 all complete 64K stream cleanly, escalation paths through
 * 32K → 64K were never end-to-end tested) and matches opencode/pi-mono
 * behavior. Only Claude Code retains escalation, tuned to its own infra.
 *
 * Also asserts the configured provider budget resolution.
 */

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
  KODAX_CAPPED_MAX_OUTPUT_TOKENS,
  KODAX_ESCALATED_MAX_OUTPUT_TOKENS,
  registerModelProvider,
} from '@kodax-ai/llm';
import { runKodaX } from './agent.js';
import { readTransientTextArtifact } from './transient-text-artifacts.js';

const TEST_PROVIDER_NAME = 'max-tokens-escalation-provider';
const TEST_PROVIDER_API_KEY_ENV = 'MAX_TOKENS_ESCALATION_PROVIDER_API_KEY';

/**
 * Programmable mock provider: each stream() call returns the next
 * pre-configured response and records the effective max_tokens budget
 * seen at that moment.
 */
class MaxTokensScriptedProvider extends KodaXBaseProvider {
  static responses: KodaXStreamResult[] = [];
  static observedBudgets: number[] = [];
  static observedMessages: KodaXMessage[][] = [];
  static streamCalls = 0;

  readonly name = TEST_PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: TEST_PROVIDER_API_KEY_ENV,
    model: 'max-tokens-test',
    supportsThinking: false,
    reasoningCapability: 'prompt-only',
    // Mirror zhipu-coding's post-Shard-A default: capped output budget
    // so the escalation branch can meaningfully trigger.
    maxOutputTokens: KODAX_CAPPED_MAX_OUTPUT_TOKENS,
    contextWindow: 100_000,
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
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    MaxTokensScriptedProvider.observedMessages.push(structuredClone(_messages));
    MaxTokensScriptedProvider.observedBudgets.push(
      streamOptions?.maxOutputTokensOverride ?? this.getEffectiveMaxOutputTokens(),
    );
    const idx = MaxTokensScriptedProvider.streamCalls;
    MaxTokensScriptedProvider.streamCalls += 1;
    const resp = MaxTokensScriptedProvider.responses[idx];
    if (!resp) {
      throw new Error(`No scripted response for stream call #${idx + 1}`);
    }
    for (const block of resp.textBlocks) {
      streamOptions?.onTextDelta?.(block.text);
    }
    return resp;
  }
}

function resetProvider(): void {
  MaxTokensScriptedProvider.responses = [];
  MaxTokensScriptedProvider.observedBudgets = [];
  MaxTokensScriptedProvider.observedMessages = [];
  MaxTokensScriptedProvider.streamCalls = 0;
}

describe('KodaXBaseProvider.getEffectiveMaxOutputTokens', () => {
  it('prefers env var > config > global fallback', () => {
    const provider = new MaxTokensScriptedProvider();
    expect(provider.getEffectiveMaxOutputTokens()).toBe(KODAX_CAPPED_MAX_OUTPUT_TOKENS);

    process.env.KODAX_MAX_OUTPUT_TOKENS = '48000';
    expect(provider.getEffectiveMaxOutputTokens()).toBe(48000);

    expect(provider.getEffectiveMaxOutputTokens()).toBe(48000);
    delete process.env.KODAX_MAX_OUTPUT_TOKENS;
    expect(provider.getEffectiveMaxOutputTokens()).toBe(KODAX_CAPPED_MAX_OUTPUT_TOKENS);
  });

  it('ignores non-positive env var values', () => {
    const provider = new MaxTokensScriptedProvider();
    process.env.KODAX_MAX_OUTPUT_TOKENS = '0';
    expect(provider.getEffectiveMaxOutputTokens()).toBe(KODAX_CAPPED_MAX_OUTPUT_TOKENS);
    process.env.KODAX_MAX_OUTPUT_TOKENS = 'not-a-number';
    expect(provider.getEffectiveMaxOutputTokens()).toBe(KODAX_CAPPED_MAX_OUTPUT_TOKENS);
    delete process.env.KODAX_MAX_OUTPUT_TOKENS;
  });
});

describe('runKodaX max_tokens continuation (L5)', () => {
  beforeEach(() => {
    resetProvider();
    process.env[TEST_PROVIDER_API_KEY_ENV] = 'test-key';
    delete process.env.KODAX_MAX_OUTPUT_TOKENS;
    registerModelProvider(
      TEST_PROVIDER_NAME,
      () => new MaxTokensScriptedProvider(),
    );
  });

  afterEach(() => {
    clearRuntimeModelProviders();
    delete process.env[TEST_PROVIDER_API_KEY_ENV];
    delete process.env.KODAX_MAX_OUTPUT_TOKENS;
  });

  it('injects continuation meta message when max_tokens hits with no tool_use', async () => {
    MaxTokensScriptedProvider.responses = [
      // Iter 0: capped budget hits max_tokens, model produced some text but
      // no tool. Agent should commit and inject the L5 meta message.
      {
        textBlocks: [{ type: 'text', text: 'first half of the long file' }],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'max_tokens',
      },
      // Iter 1 (after meta): model heeds the split hint and finishes.
      {
        textBlocks: [{ type: 'text', text: 'second half' }],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'end_turn',
      },
    ];

    const textDeltas: string[] = [];
    const segments: Array<{
      responseId: string;
      providerRequestId: string;
      mode: 'append' | 'replace';
    }> = [];
    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
        events: {
          onTextDelta: (t) => textDeltas.push(t),
          onOutputSegmentStart: (segment) => segments.push(segment),
        },
      },
      'Generate a long document.',
    );

    expect(result.success).toBe(true);
    expect(MaxTokensScriptedProvider.streamCalls).toBe(2);
    // Both turns at the capped budget — no escalation to 64K.
    expect(MaxTokensScriptedProvider.observedBudgets[0]).toBe(KODAX_CAPPED_MAX_OUTPUT_TOKENS);
    expect(MaxTokensScriptedProvider.observedBudgets[1]).toBe(KODAX_CAPPED_MAX_OUTPUT_TOKENS);
    // The Claude-Code-style meta message surfaces via onTextDelta.
    const joined = textDeltas.join('');
    expect(joined).toContain('output token limit hit');
    expect(segments.map((segment) => segment.mode)).toEqual(['append', 'append']);
    expect(segments[1]?.responseId).toBe(segments[0]?.responseId);
    expect(segments[1]?.providerRequestId).not.toBe(segments[0]?.providerRequestId);
  }, 30_000);

  it('honors a run-scoped maxOutputTokens passed to runKodaX (SDK ALS wrap)', async () => {
    // Regression guard for the SDK ALS gap: runKodaX is a public entry (startKodaX
    // wraps it) and must establish the run-scoped config (AsyncLocalStorage) so
    // per-run overrides reach the provider. Before runKodaX wrapped in
    // runWithScopedConfig, options.maxOutputTokens was silently dropped and the
    // provider fell back to its capped config default. getEffectiveMaxOutputTokens
    // reads getRunScopedConfig()?.maxOutputTokens ahead of the config default, so a
    // distinct scoped value must surface verbatim on the wire budget.
    const SCOPED_BUDGET = 23_456;
    expect(SCOPED_BUDGET).not.toBe(KODAX_CAPPED_MAX_OUTPUT_TOKENS);
    MaxTokensScriptedProvider.responses = [
      {
        textBlocks: [{ type: 'text', text: 'done' }],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'end_turn',
      },
    ];

    const result = await runKodaX(
      { provider: TEST_PROVIDER_NAME, reasoningMode: 'off', maxOutputTokens: SCOPED_BUDGET },
      'Do a small thing.',
    );

    expect(result.success).toBe(true);
    expect(MaxTokensScriptedProvider.observedBudgets[0]).toBe(SCOPED_BUDGET);
  }, 30_000);

  it('removes volatile oversized-input artifacts when the SA run settles', async () => {
    MaxTokensScriptedProvider.responses = [{
      textBlocks: [{ type: 'text', text: 'done' }],
      toolBlocks: [],
      thinkingBlocks: [],
      stopReason: 'end_turn',
    }];
    const oversized = `private sentinel\n${'evidence '.repeat(45_000)}`;

    const result = await runKodaX(
      { provider: TEST_PROVIDER_NAME, reasoningMode: 'off' },
      oversized,
    );

    expect(result.success).toBe(true);
    const wire = JSON.stringify(MaxTokensScriptedProvider.observedMessages);
    const artifactPath = wire.match(/kodax-transient:\/\/text\/[0-9a-f]{64}/)?.[0];
    expect(artifactPath).toBeDefined();
    expect(readTransientTextArtifact(artifactPath!)).toBeUndefined();
    expect(JSON.stringify(result.messages)).toContain('private sentinel');
  }, 30_000);

  it('respects user KODAX_MAX_OUTPUT_TOKENS override on every turn', async () => {
    process.env.KODAX_MAX_OUTPUT_TOKENS = '48000';
    MaxTokensScriptedProvider.responses = [
      {
        textBlocks: [{ type: 'text', text: 'partial' }],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'max_tokens',
      },
      {
        textBlocks: [{ type: 'text', text: 'rest' }],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'end_turn',
      },
    ];

    const result = await runKodaX(
      { provider: TEST_PROVIDER_NAME, reasoningMode: 'off' },
      'Generate.',
    );

    expect(result.success).toBe(true);
    // Both calls observe the user-pinned 48K — never auto-escalated.
    expect(MaxTokensScriptedProvider.observedBudgets).toEqual([48000, 48000]);
  }, 30_000);

  it('keeps KODAX_ESCALATED_MAX_OUTPUT_TOKENS above the capped default', () => {
    expect(KODAX_ESCALATED_MAX_OUTPUT_TOKENS).toBeGreaterThan(KODAX_CAPPED_MAX_OUTPUT_TOKENS);
  });
});
