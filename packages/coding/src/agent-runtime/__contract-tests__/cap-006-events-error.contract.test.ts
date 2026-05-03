/**
 * Contract test for CAP-006: onError event
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-006-onerror-event
 *
 * Test obligations:
 * - CAP-EVENTS-ERROR-001: fires before rethrow when error escapes; payload
 *   carries the caught error instance (object identity)
 *
 * Risk: HIGH_RISK_PARITY — `runner-driven.ts:3717-3721` parity-restore evidence:
 * "Legacy agent.ts:2854 fires this before rethrowing"
 *
 * Verified call site: agent-runtime/catch-terminals.ts:166
 *   `input.events.onError?.(input.error);`
 *
 * Note: CAP-005-001c covers the *fact* that onError fires on the error
 * terminal (mutually exclusive with onComplete). CAP-006 strengthens
 * that by asserting **identity** of the payload — the same Error
 * instance the substrate caught is what the callback receives. This is
 * the contract REPL UIs depend on to correlate stack traces with
 * server-side telemetry.
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

const PROVIDER_NAME = 'cap-006-test-provider';
const API_KEY_ENV = 'CAP_006_TEST_PROVIDER_API_KEY';

const SENTINEL_ERROR = new Error('cap-006 sentinel error');

class ThrowingProvider extends KodaXBaseProvider {
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
    throw SENTINEL_ERROR;
  }
}

// Issue 128: contract tests drive runKodaX end-to-end and flake at 5000ms
// default under heavy parallel vitest load. Bump per-suite to 15s.
describe('CAP-006: onError event contract', { timeout: 15_000 }, () => {
  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
    registerModelProvider(PROVIDER_NAME, () => new ThrowingProvider());
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
  });

  it('CAP-EVENTS-ERROR-001: fires with the same Error instance the substrate caught (payload identity preserved)', async () => {
    const onError = vi.fn();
    const result = await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        events: { onError },
      },
      'do thing',
    );
    // Substrate must surface a non-success terminal — error did not silently disappear.
    expect(result.success).toBe(false);
    // onError must fire exactly once with the *same* Error instance (===).
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(SENTINEL_ERROR);
    expect(onError.mock.calls[0]![0]).toBe(SENTINEL_ERROR);
  });
});
