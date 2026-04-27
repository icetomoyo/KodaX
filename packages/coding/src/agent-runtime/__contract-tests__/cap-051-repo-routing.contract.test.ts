/**
 * Contract test for CAP-051: repo routing signals computation
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-051-repo-routing-signals-computation
 *
 * Test obligations:
 * - CAP-REPO-ROUTING-001: signals propagate to reasoning plan creation
 *   AND to emitRepoIntelligenceTrace (stage='routing')
 * - CAP-REPO-ROUTING-002: best-effort — failure does not throw
 *
 * Risk: MEDIUM (best-effort — failure must not block the run)
 *
 * Class: 1
 *
 * Verified location: agent-runtime/run-substrate.ts:469-488
 *   - `options.context?.repoRoutingSignals ?? (autoMode!=='off' && cwd
 *     ? await getRepoRoutingSignals(...).catch(() => null)
 *     : null)`
 *   - `emitRepoIntelligenceTrace(events, options, 'routing', signals, detail)`
 *
 * Time-ordering constraint: AFTER runtimeSessionState construction; BEFORE
 * reasoning plan creation.
 *
 * Approach:
 *   - 001: pre-supply `options.context.repoRoutingSignals` (the `??`
 *     short-circuit) and `repoIntelligenceTrace=true`. The substrate must
 *     fire `onRepoIntelligenceTrace` for stage='routing' carrying the
 *     supplied carrier shape (capability+trace). This proves the signals
 *     propagate to the routing emission site.
 *   - 002: omit executionCwd/gitRoot AND omit `repoRoutingSignals` so the
 *     gate short-circuits to `null` — the run must complete without
 *     throwing, demonstrating no signal computation can break the run.
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
import type {
  KodaXRepoIntelligenceTraceEvent,
  KodaXRepoRoutingSignals,
} from '../../types.js';

const PROVIDER_NAME = 'cap-051-test-provider';
const API_KEY_ENV = 'CAP_051_TEST_PROVIDER_API_KEY';

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

function makeRoutingSignals(): KodaXRepoRoutingSignals {
  return {
    changedFileCount: 1,
    changedLineCount: 10,
    addedLineCount: 8,
    deletedLineCount: 2,
    touchedModuleCount: 1,
    changedModules: ['core'],
    crossModule: false,
    riskHints: [],
    activeModuleId: 'core',
    plannerBias: false,
    investigationBias: false,
    lowConfidence: false,
    capability: {
      mode: 'oss',
      engine: 'oss',
      bridge: 'shared',
      level: 'basic',
      status: 'ok',
      warnings: [],
    },
    trace: {
      mode: 'oss',
      engine: 'oss',
      bridge: 'shared',
      triggeredAt: new Date('2026-04-27T00:00:00Z').toISOString(),
      source: 'fallback',
      cliLatencyMs: 5,
      cacheHit: false,
    },
  };
}

describe('CAP-051: repo routing signals computation contract', () => {
  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
    registerModelProvider(PROVIDER_NAME, () => new StaticProvider());
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
  });

  it('CAP-REPO-ROUTING-001: pre-supplied repoRoutingSignals propagate into the routing trace emission', async () => {
    const onRepoIntelligenceTrace = vi.fn<(event: KodaXRepoIntelligenceTraceEvent) => void>();
    const signals = makeRoutingSignals();

    await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        events: { onRepoIntelligenceTrace },
        context: {
          repoIntelligenceTrace: true,
          repoRoutingSignals: signals,
        },
      },
      'do thing',
    );

    // The 'routing' stage must fire at least once carrying the supplied
    // carrier (capability + trace are the surface used by the trace event).
    const routingCalls = onRepoIntelligenceTrace.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stage === 'routing');
    expect(routingCalls.length).toBeGreaterThanOrEqual(1);
    const event = routingCalls[0]!;
    expect(event.summary).toContain('stage=routing');
    expect(event.summary).toContain('active_module=core');
    expect(event.capability).toBe(signals.capability);
    expect(event.trace).toBe(signals.trace);
  });

  it('CAP-REPO-ROUTING-002: best-effort — run completes without throwing when no executionCwd/gitRoot AND no preset signals', async () => {
    const onComplete = vi.fn();
    const onError = vi.fn();
    // No context.executionCwd, no context.gitRoot, no preset routing
    // signals. The substrate's gate short-circuits to `null` and must NOT
    // throw. The .catch(() => null) wrapper around the inline computation
    // is the broader best-effort guarantee — this test pins the safe
    // gating path.
    const result = await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        events: { onComplete, onError },
      },
      'do thing',
    );
    expect(result).toBeDefined();
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
  });
});
