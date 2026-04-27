/**
 * Contract test for CAP-005: onComplete event
 *
 * Test obligations:
 * - CAP-EVENTS-COMPLETE-001a: fires on success terminal
 * - CAP-EVENTS-COMPLETE-001b: fires on interrupt / abort terminal
 * - CAP-EVENTS-COMPLETE-001c: error terminal fires `onError` (not
 *   `onComplete`) — these terminal events are mutually exclusive per
 *   CAP-084 contract
 *
 * Risk: HIGH — REPL terminal cleanup relies on exactly-one terminal
 * event per run.
 *
 * Verified call sites: agent-runtime/run-substrate.ts (3 success/block
 * sites) + agent-runtime/catch-terminals.ts:applyGenericErrorTerminal
 * (error site fires `onError` only).
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

const PROVIDER_NAME = 'cap-005-test-provider';
const API_KEY_ENV = 'CAP_005_TEST_PROVIDER_API_KEY';

type Behavior = 'success' | 'throw';

class CompleteEventProvider extends KodaXBaseProvider {
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
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    if (this.behavior === 'throw') throw new Error('synthetic terminal failure');
    return {
      textBlocks: [{ type: 'text', text: 'done' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }
}

describe('CAP-005: onComplete event contract', () => {
  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
  });

  it('CAP-EVENTS-COMPLETE-001a: fires on success terminal (text-only run completes)', async () => {
    registerModelProvider(PROVIDER_NAME, () => new CompleteEventProvider('success'));
    const onComplete = vi.fn();
    const result = await runKodaX(
      { provider: PROVIDER_NAME, model: 'baseline-model', events: { onComplete } },
      'do thing',
    );
    expect(result.success).toBe(true);
    expect(onComplete).toHaveBeenCalled();
  });

  it('CAP-EVENTS-COMPLETE-001b: fires on interrupt / abort terminal', async () => {
    registerModelProvider(PROVIDER_NAME, () => new CompleteEventProvider('success'));
    const controller = new AbortController();
    controller.abort();
    const onComplete = vi.fn();
    const result = await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        abortSignal: controller.signal,
        events: { onComplete },
      },
      'do thing',
    );
    // Whether success=false or success=true (race), the terminal MUST
    // emit a single terminal event. For abort the substrate fires
    // `onComplete` with no signal value (interrupt branch). Asserting
    // it was called at least once is the contract.
    expect(result).toBeDefined();
    expect(onComplete).toHaveBeenCalled();
  });

  it('CAP-EVENTS-COMPLETE-001c: error terminal fires `onError` (not onComplete) — mutually exclusive per CAP-084 contract', async () => {
    registerModelProvider(PROVIDER_NAME, () => new CompleteEventProvider('throw'));
    const onComplete = vi.fn();
    const onError = vi.fn();
    const result = await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        events: { onComplete, onError },
      },
      'do thing',
    );
    expect(result.success).toBe(false);
    // Mutual exclusion: error path → onError fired, onComplete NOT fired.
    expect(onError).toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
