/**
 * Contract test for CAP-041: extension runtime activation lifecycle
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-041-extension-runtime-activation-lifecycle
 *
 * Test obligations:
 * - CAP-EXT-RUNTIME-001: entry binds + hydrates extension runtime
 * - CAP-EXT-RUNTIME-002: release fires on success
 * - CAP-EXT-RUNTIME-003: release fires on error
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/run-substrate.ts:355
 *   `setActiveExtensionRuntime(runtime)` (frame entry binding),
 * :462 `runtime?.bindController(...)` and :466 `await runtime?.hydrateSession(sessionId)`
 *   (controller/session bind), :1479-1481 outer `finally` releaseRuntimeBinding
 *   + restore previousActiveRuntime.
 *
 * Time-ordering constraint: bind BEFORE first tool dispatch; hydrate BEFORE
 * first prompt build; release in finally even on error.
 *
 * Note: CAP-086 already exercises 002/003 release-on-success / release-on-error
 * via `previousActiveRuntime` restoration. CAP-041's distinct contribution
 * is **001** — verifying that bindController + hydrateSession both fire
 * during frame entry. We retain a smaller release-spy assertion in 002/003
 * to lock the spy-level identity (the same binding the substrate captured
 * is the function the finally calls).
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
import {
  createExtensionRuntime,
  getActiveExtensionRuntime,
} from '../../extensions/index.js';
import { setActiveExtensionRuntime } from '../../extensions/runtime.js';

const PROVIDER_NAME = 'cap-041-test-provider';
const API_KEY_ENV = 'CAP_041_TEST_PROVIDER_API_KEY';

type Behavior = 'success' | 'throw';

class LifecycleProvider extends KodaXBaseProvider {
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
    if (this.behavior === 'throw') throw new Error('synthetic CAP-041 failure');
    return {
      textBlocks: [{ type: 'text', text: 'ok' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }
}

describe('CAP-041: extension runtime activation lifecycle contract', () => {
  let baselineRuntime: ReturnType<typeof getActiveExtensionRuntime>;

  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
    baselineRuntime = getActiveExtensionRuntime();
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
    setActiveExtensionRuntime(baselineRuntime);
  });

  it('CAP-EXT-RUNTIME-001: frame entry calls bindController + hydrateSession before first tool dispatch', async () => {
    const runtime = createExtensionRuntime();
    setActiveExtensionRuntime(runtime);
    const bindSpy = vi.spyOn(runtime, 'bindController');
    const hydrateSpy = vi.spyOn(runtime, 'hydrateSession');

    registerModelProvider(PROVIDER_NAME, () => new LifecycleProvider('success'));
    await runKodaX(
      { provider: PROVIDER_NAME, model: 'baseline-model' },
      'do thing',
    );

    expect(bindSpy).toHaveBeenCalled();
    expect(hydrateSpy).toHaveBeenCalled();
    // bindController must run before hydrateSession — controller binding
    // is a precondition for any session-state writes during hydration.
    const bindOrder = bindSpy.mock.invocationCallOrder[0]!;
    const hydrateOrder = hydrateSpy.mock.invocationCallOrder[0]!;
    expect(bindOrder).toBeLessThan(hydrateOrder);
  });

  it('CAP-EXT-RUNTIME-002: releaseRuntimeBinding fires on success path (the disposer returned by bindController is invoked)', async () => {
    const runtime = createExtensionRuntime();
    setActiveExtensionRuntime(runtime);
    // Wrap bindController so we can capture & spy on the disposer it returns.
    const originalBind = runtime.bindController.bind(runtime);
    const releaseSpy = vi.fn();
    vi.spyOn(runtime, 'bindController').mockImplementation((controller) => {
      const realDisposer = originalBind(controller);
      return () => {
        releaseSpy();
        realDisposer();
      };
    });

    registerModelProvider(PROVIDER_NAME, () => new LifecycleProvider('success'));
    await runKodaX(
      { provider: PROVIDER_NAME, model: 'baseline-model' },
      'do thing',
    );

    expect(releaseSpy).toHaveBeenCalled();
    // And per CAP-086: previousActiveRuntime is restored.
    expect(getActiveExtensionRuntime()).toBe(runtime);
  });

  it('CAP-EXT-RUNTIME-003: releaseRuntimeBinding fires on error path (finally runs even when provider throws)', async () => {
    const runtime = createExtensionRuntime();
    setActiveExtensionRuntime(runtime);
    const originalBind = runtime.bindController.bind(runtime);
    const releaseSpy = vi.fn();
    vi.spyOn(runtime, 'bindController').mockImplementation((controller) => {
      const realDisposer = originalBind(controller);
      return () => {
        releaseSpy();
        realDisposer();
      };
    });

    registerModelProvider(PROVIDER_NAME, () => new LifecycleProvider('throw'));
    const result = await runKodaX(
      { provider: PROVIDER_NAME, model: 'baseline-model' },
      'do thing',
    );

    expect(result.success).toBe(false);
    expect(releaseSpy).toHaveBeenCalled();
    expect(getActiveExtensionRuntime()).toBe(runtime);
  });
});
