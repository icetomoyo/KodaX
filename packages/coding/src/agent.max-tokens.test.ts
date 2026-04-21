/**
 * Max-tokens escalation + continuation tests (Shard A + B).
 *
 * Covers the two-level recovery ladder for `stop_reason: max_tokens`:
 *  1. Escalation: capped-budget turn hits the cap → same-turn retry at
 *     KODAX_ESCALATED_MAX_OUTPUT_TOKENS, no partial assistant pushed.
 *  2. Continuation: escalated turn STILL hits the cap → commit assistant,
 *     inject meta user message ("Break remaining work into smaller pieces"),
 *     start a new logical turn. Capped at KODAX_MAX_MAXTOKENS_RETRIES.
 *
 * Also asserts the public setter/getter wired on KodaXBaseProvider and
 * the env-var override `KODAX_MAX_OUTPUT_TOKENS` disables the auto-ladder.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax/ai';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  KODAX_CAPPED_MAX_OUTPUT_TOKENS,
  KODAX_ESCALATED_MAX_OUTPUT_TOKENS,
  registerModelProvider,
} from '@kodax/ai';
import { runKodaX } from './agent.js';

const TEST_PROVIDER_NAME = 'max-tokens-escalation-provider';
const TEST_PROVIDER_API_KEY_ENV = 'MAX_TOKENS_ESCALATION_PROVIDER_API_KEY';

/**
 * Programmable mock provider: each stream() call returns the next
 * pre-configured response and records the effective max_tokens budget
 * seen at that moment (so tests can assert escalation actually flipped
 * the override on the provider instance).
 */
class MaxTokensScriptedProvider extends KodaXBaseProvider {
  static responses: KodaXStreamResult[] = [];
  static observedBudgets: number[] = [];
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
    MaxTokensScriptedProvider.observedBudgets.push(this.getEffectiveMaxOutputTokens());
    const idx = MaxTokensScriptedProvider.streamCalls;
    MaxTokensScriptedProvider.streamCalls += 1;
    const resp = MaxTokensScriptedProvider.responses[idx];
    if (!resp) {
      throw new Error(`No scripted response for stream call #${idx + 1}`);
    }
    for (const block of resp.textBlocks) {
      streamOptions?.onTextDelta?.(block.text);
    }
    // Mirror withRateLimit's auto-clear of the override after success.
    this.setMaxOutputTokensOverride(undefined);
    return resp;
  }
}

function resetProvider(): void {
  MaxTokensScriptedProvider.responses = [];
  MaxTokensScriptedProvider.observedBudgets = [];
  MaxTokensScriptedProvider.streamCalls = 0;
}

describe('KodaXBaseProvider.getEffectiveMaxOutputTokens', () => {
  it('prefers override > env var > config > global fallback', () => {
    const provider = new MaxTokensScriptedProvider();
    expect(provider.getEffectiveMaxOutputTokens()).toBe(KODAX_CAPPED_MAX_OUTPUT_TOKENS);

    process.env.KODAX_MAX_OUTPUT_TOKENS = '48000';
    expect(provider.getEffectiveMaxOutputTokens()).toBe(48000);

    provider.setMaxOutputTokensOverride(KODAX_ESCALATED_MAX_OUTPUT_TOKENS);
    expect(provider.getEffectiveMaxOutputTokens()).toBe(KODAX_ESCALATED_MAX_OUTPUT_TOKENS);

    provider.setMaxOutputTokensOverride(undefined);
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

describe('runKodaX max_tokens escalation + continuation', () => {
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

  it('escalates capped budget to 64K on first max_tokens, succeeds without pushing a truncated assistant', async () => {
    MaxTokensScriptedProvider.responses = [
      // First attempt: capped budget hits max_tokens → escalation path kicks in,
      // NO assistant committed to history.
      {
        textBlocks: [],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'max_tokens',
      },
      // Second attempt: same turn, escalated budget, clean end_turn.
      {
        textBlocks: [{ type: 'text', text: 'done at 64K' }],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'end_turn',
      },
    ];

    const result = await runKodaX(
      { provider: TEST_PROVIDER_NAME, reasoningMode: 'off' },
      'Please write a large HTML file.',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toContain('done at 64K');
    expect(MaxTokensScriptedProvider.streamCalls).toBe(2);
    // First call used capped default, second saw the escalated override.
    expect(MaxTokensScriptedProvider.observedBudgets[0]).toBe(KODAX_CAPPED_MAX_OUTPUT_TOKENS);
    expect(MaxTokensScriptedProvider.observedBudgets[1]).toBe(KODAX_ESCALATED_MAX_OUTPUT_TOKENS);
  }, 15_000);

  it('falls through to continuation meta message when escalated budget still hits the cap', async () => {
    MaxTokensScriptedProvider.responses = [
      // Iter 0: capped → max_tokens → escalate.
      { textBlocks: [], toolBlocks: [], thinkingBlocks: [], stopReason: 'max_tokens' },
      // Iter 1 (escalated): 64K still not enough → L5 continuation injects
      // meta message. Partial text is committed this time.
      {
        textBlocks: [{ type: 'text', text: 'first half of the long file' }],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'max_tokens',
      },
      // Iter 2 (new logical turn after meta): model heeds the split hint.
      {
        textBlocks: [{ type: 'text', text: 'second half' }],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'end_turn',
      },
    ];

    const textDeltas: string[] = [];
    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
        events: {
          onTextDelta: (t) => textDeltas.push(t),
        },
      },
      'Generate a long document.',
    );

    expect(result.success).toBe(true);
    expect(MaxTokensScriptedProvider.streamCalls).toBe(3);
    // Escalation uses 64K on iter 1.
    expect(MaxTokensScriptedProvider.observedBudgets[1]).toBe(KODAX_ESCALATED_MAX_OUTPUT_TOKENS);
    // After L5 continuation the next logical turn resets to capped default.
    expect(MaxTokensScriptedProvider.observedBudgets[2]).toBe(KODAX_CAPPED_MAX_OUTPUT_TOKENS);
    // The Claude Code-style meta message surfaces via onTextDelta.
    const joined = textDeltas.join('');
    expect(joined).toContain('output token limit hit');
  }, 15_000);

  it('skips escalation when KODAX_MAX_OUTPUT_TOKENS is set by the user', async () => {
    process.env.KODAX_MAX_OUTPUT_TOKENS = '32000';
    MaxTokensScriptedProvider.responses = [
      // First attempt at user-specified budget hits max_tokens.
      { textBlocks: [], toolBlocks: [], thinkingBlocks: [], stopReason: 'max_tokens' },
      // With env override, escalation is skipped; agent commits the (empty)
      // assistant message and immediately emits the L5 continuation meta.
      {
        textBlocks: [{ type: 'text', text: 'picking up smaller' }],
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
    expect(MaxTokensScriptedProvider.streamCalls).toBe(2);
    // Both calls observe the user-pinned 32K — no auto escalation to 64K.
    expect(MaxTokensScriptedProvider.observedBudgets).toEqual([32000, 32000]);
  }, 15_000);

  it('does not escalate when the effective budget already meets or exceeds the escalated threshold', async () => {
    process.env.KODAX_MAX_OUTPUT_TOKENS = String(KODAX_ESCALATED_MAX_OUTPUT_TOKENS);
    MaxTokensScriptedProvider.responses = [
      { textBlocks: [], toolBlocks: [], thinkingBlocks: [], stopReason: 'max_tokens' },
      {
        textBlocks: [{ type: 'text', text: 'ok' }],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'end_turn',
      },
    ];

    await runKodaX(
      { provider: TEST_PROVIDER_NAME, reasoningMode: 'off' },
      'Generate.',
    );

    // Both budgets equal — escalation branch short-circuited.
    expect(MaxTokensScriptedProvider.observedBudgets[0]).toBe(KODAX_ESCALATED_MAX_OUTPUT_TOKENS);
    expect(MaxTokensScriptedProvider.observedBudgets[1]).toBe(KODAX_ESCALATED_MAX_OUTPUT_TOKENS);
  }, 15_000);
});
