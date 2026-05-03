/**
 * Contract test for CAP-004: onStreamEnd event
 *
 * Test obligations:
 * - CAP-EVENTS-STREAM-END-001: fires at least once per provider stream
 *   completion (including the final turn before the substrate terminal)
 *
 * Risk: HIGH — REPL relies on this to clear streaming UI on every turn.
 *
 * Verified call site: agent-runtime/run-substrate.ts (multiple sites
 * — one per provider call completion). Multi-site is deliberate so the
 * recovery path's re-stream still produces a fresh `onStreamEnd`.
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

const PROVIDER_NAME = 'cap-004-test-provider';
const API_KEY_ENV = 'CAP_004_TEST_PROVIDER_API_KEY';

class TextOnlyProvider extends KodaXBaseProvider {
  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: API_KEY_ENV,
    model: 'baseline-model',
    supportsThinking: false,
  };

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    return {
      textBlocks: [{ type: 'text', text: 'final answer' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }
}

// Issue 128: contract tests drive runKodaX end-to-end and flake at 5000ms
// default under heavy parallel vitest load. Bump per-suite to 15s.
describe('CAP-004: onStreamEnd event contract', { timeout: 15_000 }, () => {
  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
    registerModelProvider(PROVIDER_NAME, () => new TextOnlyProvider());
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
  });

  it('CAP-EVENTS-STREAM-END-001: fires at least once after the provider stream finalizes (text-only single-turn run)', async () => {
    const onStreamEnd = vi.fn();
    await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        events: { onStreamEnd },
      },
      'do thing',
    );
    expect(onStreamEnd.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
