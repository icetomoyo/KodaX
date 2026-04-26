/**
 * Contract test for CAP-055: per-turn provider/model/thinkingLevel re-resolution
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-055-per-turn-providermodelthinkinglevel-re-resolution
 *
 * Test obligations:
 * - CAP-PER-TURN-PROVIDER-001: extension override propagates to next turn
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/per-turn-provider-resolution.ts (extracted
 * from agent.ts:544-553 — pre-FEATURE_100 baseline — during FEATURE_100 P3.1)
 *
 * Time-ordering constraint: at iteration start; BEFORE provider config check
 * (CAP-042) per-turn re-validation. The check itself is folded INTO this step
 * (the `provider.isConfigured()` throw lives inside `resolvePerTurnProvider`).
 *
 * Active here:
 *   - resolution priority: `sessionState.modelSelection.*` wins over
 *     `options.modelOverride` wins over `options.model`
 *   - `provider.isConfigured()` throw with the canonical "Set $API_KEY_ENV"
 *     message when the resolved provider is not configured
 *   - `contextWindow` cascade delegates to CAP-056's `resolveContextWindow`
 *
 * STATUS: ACTIVE since FEATURE_100 P3.1.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXOptions } from '../../types.js';
import type { CompactionConfig } from '@kodax/agent';
import type { RuntimeSessionState } from '../runtime-session-state.js';

import { resolvePerTurnProvider } from '../per-turn-provider-resolution.js';

function fakeOptions(overrides: Partial<KodaXOptions> = {}): KodaXOptions {
  return {
    provider: 'anthropic',
    ...overrides,
  } as unknown as KodaXOptions;
}

function fakeSessionState(overrides: Partial<RuntimeSessionState> = {}): RuntimeSessionState {
  return {
    modelSelection: { provider: undefined, model: undefined },
    thinkingLevel: undefined,
    extensionState: new Map(),
    activeTools: new Set(),
    ...overrides,
  } as unknown as RuntimeSessionState;
}

const compactionConfig = { enabled: true, triggerPercent: 75 } as CompactionConfig;

describe('CAP-055: resolvePerTurnProvider — per-turn re-resolution', () => {
  it('CAP-PER-TURN-PROVIDER-001a: extension-set sessionState.modelSelection.provider overrides options.provider', () => {
    // Anthropic env is reliably set in test envs (default). Use it as the
    // override target so isConfigured() doesn't throw.
    const sessionState = fakeSessionState({
      modelSelection: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    });
    const result = resolvePerTurnProvider(
      sessionState,
      fakeOptions({ provider: 'openai' }), // user-supplied default — should LOSE
      compactionConfig,
    );
    expect(result.providerName).toBe('anthropic');
    expect(result.modelOverride).toBe('claude-sonnet-4-5');
  });

  it('CAP-PER-TURN-PROVIDER-001b: thinkingLevel propagates from sessionState', () => {
    const sessionState = fakeSessionState({ thinkingLevel: 'deep' });
    const result = resolvePerTurnProvider(
      sessionState,
      fakeOptions(),
      compactionConfig,
    );
    expect(result.thinkingLevel).toBe('deep');
  });

  it('CAP-PER-TURN-PROVIDER-001c: model resolution priority — modelSelection > options.modelOverride > options.model', () => {
    // sessionState empty, modelOverride set, model set — modelOverride wins
    const result1 = resolvePerTurnProvider(
      fakeSessionState(),
      fakeOptions({ modelOverride: 'override-model', model: 'plain-model' } as Partial<KodaXOptions>),
      compactionConfig,
    );
    expect(result1.modelOverride).toBe('override-model');

    // sessionState set — wins over both
    const result2 = resolvePerTurnProvider(
      fakeSessionState({
        modelSelection: { provider: undefined, model: 'session-model' },
      }),
      fakeOptions({ modelOverride: 'override-model', model: 'plain-model' } as Partial<KodaXOptions>),
      compactionConfig,
    );
    expect(result2.modelOverride).toBe('session-model');
  });

  it('CAP-PER-TURN-PROVIDER-001d: missing API key env causes resolution to throw', () => {
    // Either `resolveProvider` (constructor throws when env missing) or
    // the explicit `isConfigured` check inside `resolvePerTurnProvider`
    // raises. The contract is "missing env terminates the turn", not the
    // exact message format.
    const originalEnv = process.env.KIMI_API_KEY;
    delete process.env.KIMI_API_KEY;
    // Precondition assertion: if a test setup re-populates this env between
    // the delete and the resolvePerTurnProvider call, the throw path goes
    // unexercised — fail loudly here rather than silently pass downstream.
    expect(process.env.KIMI_API_KEY).toBeUndefined();
    try {
      expect(() => {
        resolvePerTurnProvider(
          fakeSessionState({
            modelSelection: { provider: 'kimi', model: undefined },
          }),
          fakeOptions(),
          compactionConfig,
        );
      }).toThrow(/KIMI_API_KEY/);
    } finally {
      if (originalEnv !== undefined) process.env.KIMI_API_KEY = originalEnv;
    }
  });

  it('CAP-PER-TURN-PROVIDER-001e: contextWindow delegates to CAP-056 resolveContextWindow cascade', () => {
    // compactionConfig.contextWindow set → wins regardless of provider's
    // own getEffectiveContextWindow (per CAP-056 step 1).
    const overrideConfig = { ...compactionConfig, contextWindow: 99_999 } as CompactionConfig;
    const result = resolvePerTurnProvider(
      fakeSessionState(),
      fakeOptions(),
      overrideConfig,
    );
    expect(result.contextWindow).toBe(99_999);
  });
});
