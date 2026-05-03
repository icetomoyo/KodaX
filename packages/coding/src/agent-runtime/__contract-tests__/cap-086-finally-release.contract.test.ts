/**
 * Contract test for CAP-086: finally cleanup (extension runtime release)
 *
 * Test obligations:
 * - CAP-FINALLY-RELEASE-001: release fires + previousActiveRuntime restored
 *   on success path
 * - CAP-FINALLY-RELEASE-002: release fires + previousActiveRuntime restored
 *   on error path
 * - CAP-FINALLY-RELEASE-003: release fires + previousActiveRuntime restored
 *   on AbortError / interrupt path
 *
 * Risk: HIGH (must run on every terminal — error / cancel / iteration
 * limit / managed-protocol exit / max-tokens exit / provider-rejection
 * exit — to prevent runtime leak across `runKodaX` calls)
 *
 * Class: 1
 *
 * Verified location: agent-runtime/run-substrate.ts:347-355
 * (`previousActiveRuntime` capture + `setActiveExtensionRuntime`
 * binding) and :1478-1485 (outer `finally` that releases the binding
 * and restores `previousActiveRuntime`).
 *
 * Time-ordering constraint: LAST — outer finally; runs after every
 * terminal path.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6t.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { KodaXBaseProvider, clearRuntimeModelProviders } from '@kodax/ai';
import { registerModelProvider } from '@kodax/ai';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax/ai';

import { runKodaX } from '../../agent.js';
import {
  createExtensionRuntime,
  getActiveExtensionRuntime,
} from '../../extensions/index.js';
import { setActiveExtensionRuntime } from '../../extensions/runtime.js';

const TEST_PROVIDER_NAME = 'cap-086-test-provider';
const TEST_API_KEY_ENV = 'CAP_086_TEST_PROVIDER_API_KEY';

type ProviderBehavior = 'success' | 'throw' | 'abort';

class FinallyReleaseTestProvider extends KodaXBaseProvider {
  readonly name = TEST_PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: TEST_API_KEY_ENV,
    model: 'baseline-model',
    supportsThinking: false,
  };

  constructor(private readonly behavior: ProviderBehavior) {
    super();
  }

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    if (this.behavior === 'throw') {
      throw new Error('synthetic provider failure for CAP-086');
    }
    if (this.behavior === 'abort') {
      // Simulate abort propagation: if the caller-supplied signal is
      // aborted (or aborts mid-stream), throw an AbortError. The
      // runKodaX path treats this as an interrupt terminal and runs
      // the same finally block.
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
    return {
      textBlocks: [{ type: 'text', text: 'success' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }
}

// Issue 128: contract tests drive runKodaX end-to-end and flake at 5000ms
// default under heavy parallel vitest load. Bump per-suite to 15s.
describe('CAP-086: finally cleanup (extension runtime release) contract', { timeout: 15_000 }, () => {
  let baselineRuntime: ReturnType<typeof getActiveExtensionRuntime>;

  beforeEach(() => {
    process.env[TEST_API_KEY_ENV] = 'test-key';
    // Snapshot whatever runtime the host environment has installed
    // (may be undefined). The contract guarantee is "post-runKodaX
    // active runtime === pre-runKodaX active runtime".
    baselineRuntime = getActiveExtensionRuntime();
  });

  afterEach(() => {
    delete process.env[TEST_API_KEY_ENV];
    clearRuntimeModelProviders();
    // Best-effort restore in case a test failed mid-flight.
    setActiveExtensionRuntime(baselineRuntime);
  });

  it('CAP-FINALLY-RELEASE-001: success path → active runtime is restored to the pre-call value', async () => {
    const installedRuntime = createExtensionRuntime();
    setActiveExtensionRuntime(installedRuntime);
    const expectedAfter = installedRuntime;

    registerModelProvider(TEST_PROVIDER_NAME, () => new FinallyReleaseTestProvider('success'));
    await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        model: 'baseline-model',
      },
      'do thing',
    );

    // Post-call: active runtime is the pre-call runtime (the test's
    // installed runtime), not whatever was bound mid-flight.
    expect(getActiveExtensionRuntime()).toBe(expectedAfter);
  });

  it('CAP-FINALLY-RELEASE-002: error path (provider throws) → finally still restores active runtime', async () => {
    const installedRuntime = createExtensionRuntime();
    setActiveExtensionRuntime(installedRuntime);

    registerModelProvider(TEST_PROVIDER_NAME, () => new FinallyReleaseTestProvider('throw'));
    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        model: 'baseline-model',
      },
      'do thing',
    );
    // runKodaX swallows the provider error into KodaXResult.success=false
    // (it does NOT propagate as a thrown exception); the contract is
    // about the finally block — it must run regardless.
    expect(result.success).toBe(false);
    expect(getActiveExtensionRuntime()).toBe(installedRuntime);
  });

  it('CAP-FINALLY-RELEASE-003: AbortError / interrupt path → finally still restores active runtime', async () => {
    const installedRuntime = createExtensionRuntime();
    setActiveExtensionRuntime(installedRuntime);

    const controller = new AbortController();
    // Pre-abort the signal so the substrate's first abort gate (or
    // the provider's signal-aware throw) classifies this as an
    // interrupt terminal.
    controller.abort();

    registerModelProvider(TEST_PROVIDER_NAME, () => new FinallyReleaseTestProvider('abort'));
    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        model: 'baseline-model',
        abortSignal: controller.signal,
      },
      'do thing',
    );
    // result is well-formed (no thrown exception escapes)
    expect(result).toBeDefined();
    expect(getActiveExtensionRuntime()).toBe(installedRuntime);
  });
});
