/**
 * Contract test for CAP-003: onSessionStart event
 *
 * Test obligations:
 * - CAP-EVENTS-SESSION-START-001: fires exactly once per Runner frame
 *   entry, before the first provider stream completes
 *
 * Risk: HIGH — observability of session lifecycle starts here.
 *
 * Verified call site: agent-runtime/run-substrate.ts (single
 * `events.onSessionStart?.(...)` site at frame entry).
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

const PROVIDER_NAME = 'cap-003-test-provider';
const API_KEY_ENV = 'CAP_003_TEST_PROVIDER_API_KEY';

class StaticProvider extends KodaXBaseProvider {
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
      textBlocks: [{ type: 'text', text: 'ok' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }
}

describe('CAP-003: onSessionStart event contract', () => {
  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
    registerModelProvider(PROVIDER_NAME, () => new StaticProvider());
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
  });

  it('CAP-EVENTS-SESSION-START-001: fires exactly once per runKodaX invocation', async () => {
    const onSessionStart = vi.fn();
    await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        events: { onSessionStart },
      },
      'do thing',
    );
    expect(onSessionStart).toHaveBeenCalledTimes(1);
  });
});
