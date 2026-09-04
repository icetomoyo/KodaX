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
  KodaXProviderError,
  clearRuntimeModelProviders,
  registerModelProvider,
} from '@kodax-ai/llm';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';

import { runKodaX } from '../../agent.js';

const PROVIDER_NAME = 'cap-006-test-provider';
const API_KEY_ENV = 'CAP_006_TEST_PROVIDER_API_KEY';

const SENTINEL_ERROR = new Error('cap-006 sentinel error');
const TOOL_FAILURE_PROVIDER_NAME = 'cap-006-tool-failure-provider';
const TOOL_FAILURE_API_KEY_ENV = 'CAP_006_TOOL_FAILURE_PROVIDER_API_KEY';
const RAW_PROVIDER_SECRET = 'RAW_PROVIDER_BODY_MUST_NOT_PERSIST';

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

class ToolThenFailProvider extends KodaXBaseProvider {
  static calls = 0;

  readonly name = TOOL_FAILURE_PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: TOOL_FAILURE_API_KEY_ENV,
    model: 'tool-failure-model',
    supportsThinking: false,
  };

  async stream(): Promise<KodaXStreamResult> {
    ToolThenFailProvider.calls += 1;
    if (ToolThenFailProvider.calls === 1) {
      return {
        textBlocks: [],
        toolBlocks: [{
          type: 'tool_use',
          id: 'read-once',
          name: 'read',
          input: { path: 'package.json', offset: 1, limit: 1 },
        }],
        thinkingBlocks: [],
        stopReason: 'tool_use',
      };
    }
    throw new KodaXProviderError(
      `400 upstream rejected payload ${RAW_PROVIDER_SECRET}`,
      TOOL_FAILURE_PROVIDER_NAME,
      {
        stage: 'transport',
        httpStatus: 400,
        upstreamCode: 'invalid_request_error',
        requestId: 'req-safe-123',
      },
    );
  }
}

// Issue 128: contract tests drive runKodaX end-to-end and flake at 5000ms
// default under heavy parallel vitest load. Match the 30s contract-test budget.
describe('CAP-006: onError event contract', { timeout: 30_000 }, () => {
  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
    process.env[TOOL_FAILURE_API_KEY_ENV] = 'test-key';
    ToolThenFailProvider.calls = 0;
    registerModelProvider(PROVIDER_NAME, () => new ThrowingProvider());
    registerModelProvider(TOOL_FAILURE_PROVIDER_NAME, () => new ToolThenFailProvider());
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    delete process.env[TOOL_FAILURE_API_KEY_ENV];
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
    expect(onError).toHaveBeenCalledWith(SENTINEL_ERROR, expect.objectContaining({
      sessionId: expect.any(String),
      seq: expect.any(Number),
      turnId: expect.any(String),
      timestamp: expect.any(String),
    }));
    expect(onError.mock.calls[0]![0]).toBe(SENTINEL_ERROR);
  });

  it('keeps a safe structured failure when the request after a tool result fails', async () => {
    const onTurnFailed = vi.fn();
    const result = await runKodaX(
      {
        provider: TOOL_FAILURE_PROVIDER_NAME,
        model: 'tool-failure-model',
        reasoningMode: 'off',
        maxIter: 2,
        context: { gitRoot: process.cwd(), executionCwd: process.cwd() },
        events: { onTurnFailed },
      },
      'Read one line, then stop.',
    );

    expect(result.success).toBe(false);
    expect(result.lastText).toBe('');
    expect(result.failure).toMatchObject({
      message: 'Provider rejected the request. (KodaXProviderError; HTTP 400; invalid_request_error)',
      safeMessage: 'Provider rejected the request.',
      errorName: 'KodaXProviderError',
      errorClass: 'non_retryable_provider_error',
      code: 'invalid_request_error',
      provider: TOOL_FAILURE_PROVIDER_NAME,
      model: 'tool-failure-model',
      requestPhase: 'before_first_delta',
      providerStage: 'transport',
      httpStatus: 400,
      upstreamCode: 'invalid_request_error',
      requestId: 'req-safe-123',
    });
    expect(result.failure?.elapsedMs).toEqual(expect.any(Number));
    expect(result.errorMetadata?.lastError).toBe(
      'Provider rejected the request. (KodaXProviderError; HTTP 400; invalid_request_error)',
    );
    expect(onTurnFailed).toHaveBeenCalledWith(expect.objectContaining({
      error: {
        name: 'KodaXProviderError',
        message: 'Provider rejected the request. (KodaXProviderError; HTTP 400; invalid_request_error)',
      },
    }));
    expect(JSON.stringify(onTurnFailed.mock.calls)).not.toContain(RAW_PROVIDER_SECRET);
    expect(ToolThenFailProvider.calls).toBe(2);
    const toolResults = result.messages.flatMap((message) => (
      Array.isArray(message.content)
        ? message.content.filter((block) => block.type === 'tool_result')
        : []
    ));
    expect(toolResults).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(RAW_PROVIDER_SECRET);
  });
});
