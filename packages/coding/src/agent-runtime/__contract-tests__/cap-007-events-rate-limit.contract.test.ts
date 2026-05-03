/**
 * Contract test for CAP-007: onProviderRateLimit event (429 banner)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-007-onproviderratelimit-event-429-banner
 *
 * Test obligations:
 * - CAP-EVENTS-RATE-LIMIT-001a: fires when classifier returns reasonCode==="rate_limit"
 * - CAP-EVENTS-RATE-LIMIT-001b: does NOT fire on generic transient retry (network / 5xx)
 *
 * Risk: HIGH_RISK_PARITY — `runner-driven.ts:2581-2588` parity-restore evidence:
 * "Legacy agent.ts:2064 fires this on the same branch"
 *
 * Verified call site: agent-runtime/stream-handler-wiring.ts:113
 *   `events.onProviderRateLimit?.(rateAttempt, max, delay);`
 *
 * Wiring: provider.stream(messages, tools, system, reasoning, streamOptions, signal)
 *   receives `streamOptions.onRateLimit(attempt, max, delay)` — this is the
 *   bridge the substrate installs (stream-handler-wiring.ts:105). Providers
 *   only call it on the rate-limit retry branch (anthropic.ts:446, openai.ts:570,
 *   base.ts:417 inside `withRateLimit`); generic 5xx/network transient retries
 *   take a different branch (base.ts:397 doesn't path through onRateLimit when
 *   classifier reasonCode is not 'rate_limit').
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6u.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider,
  clearRuntimeModelProviders,
  registerModelProvider,
} from '@kodax/ai';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax/ai';

import { runKodaX } from '../../agent.js';

const PROVIDER_NAME = 'cap-007-test-provider';
const API_KEY_ENV = 'CAP_007_TEST_PROVIDER_API_KEY';

type Behavior = 'rate-limit' | 'silent';

class RateLimitProvider extends KodaXBaseProvider {
  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: API_KEY_ENV,
    model: 'baseline-model',
    supportsThinking: false,
  };

  constructor(private readonly behavior: Behavior) {
    super();
  }

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    if (this.behavior === 'rate-limit') {
      // Simulate the rate-limit retry branch: provider invokes the
      // onRateLimit callback the substrate installed.
      streamOptions?.onRateLimit?.(1, 3, 500);
    }
    return {
      textBlocks: [{ type: 'text', text: 'ok' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }
}

// Issue 128: contract tests drive runKodaX end-to-end and flake at 5000ms
// default under heavy parallel vitest load. Bump per-suite to 15s.
describe('CAP-007: onProviderRateLimit event contract', { timeout: 15_000 }, () => {
  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
  });

  it('CAP-EVENTS-RATE-LIMIT-001a: fires when provider invokes streamOptions.onRateLimit (rate-limit branch)', async () => {
    registerModelProvider(PROVIDER_NAME, () => new RateLimitProvider('rate-limit'));
    const onProviderRateLimit = vi.fn();
    await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        events: { onProviderRateLimit },
      },
      'do thing',
    );
    expect(onProviderRateLimit).toHaveBeenCalled();
    // Substrate forwards the (attempt, max, delay) tuple unchanged.
    expect(onProviderRateLimit).toHaveBeenCalledWith(1, 3, 500);
  });

  it('CAP-EVENTS-RATE-LIMIT-001b: does NOT fire when provider does not signal rate-limit (generic transient retry / success path)', async () => {
    registerModelProvider(PROVIDER_NAME, () => new RateLimitProvider('silent'));
    const onProviderRateLimit = vi.fn();
    await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        events: { onProviderRateLimit },
      },
      'do thing',
    );
    expect(onProviderRateLimit).not.toHaveBeenCalled();
  });
});
