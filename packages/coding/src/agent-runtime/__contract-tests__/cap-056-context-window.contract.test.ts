/**
 * Contract test for CAP-056: effective context window resolution cascade
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-056-effective-context-window-resolution-cascade
 *
 * Test obligations:
 * - CAP-CONTEXT-WINDOW-001: cascade picks model-specific value when available
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/context-window.ts (extracted from
 * agent.ts:1700-1703 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: BEFORE compaction decision (CAP-059).
 *
 * Active here: the four-step priority cascade —
 *   1. `compactionConfig.contextWindow` (operator override) wins first
 *   2. `provider.getEffectiveContextWindow?.(model)` (per-model)
 *   3. `provider.getContextWindow?.()` (provider-level default)
 *   4. `DEFAULT_CONTEXT_WINDOW` (200000) hard fallback
 * The optional-chained calls are load-bearing — providers that don't
 * implement either capability check just fall through.
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import type { KodaXBaseProvider } from '@kodax/ai';
import type { CompactionConfig } from '@kodax/agent';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONTEXT_WINDOW,
  resolveContextWindow,
} from '../context-window.js';

function fakeProvider(overrides: Partial<KodaXBaseProvider> = {}): KodaXBaseProvider {
  return {
    name: 'fake',
    isConfigured: () => true,
    getApiKeyEnv: () => 'FAKE_API_KEY',
    ...overrides,
  } as unknown as KodaXBaseProvider;
}

function config(contextWindow?: number): CompactionConfig {
  return { enabled: true, triggerPercent: 75, contextWindow } as CompactionConfig;
}

describe('CAP-056: resolveContextWindow — cascade priority', () => {
  it('CAP-CONTEXT-WINDOW-001a: compactionConfig.contextWindow wins unconditionally (operator override)', () => {
    const provider = fakeProvider({
      getEffectiveContextWindow: () => 999999,
      getContextWindow: () => 888888,
    });
    expect(resolveContextWindow(config(123456), provider, 'any-model')).toBe(123456);
  });

  it('CAP-CONTEXT-WINDOW-001b: provider.getEffectiveContextWindow wins over getContextWindow when config is unset', () => {
    const provider = fakeProvider({
      getEffectiveContextWindow: () => 50_000,
      getContextWindow: () => 200_000,
    });
    expect(resolveContextWindow(config(undefined), provider, 'any-model')).toBe(50_000);
  });

  it('CAP-CONTEXT-WINDOW-001c: getEffectiveContextWindow receives the modelOverride argument', () => {
    let seenModel: string | undefined;
    const provider = fakeProvider({
      getEffectiveContextWindow: (model?: string) => {
        seenModel = model;
        return model === 'sonnet-4-5' ? 800_000 : 100_000;
      },
    });
    const result = resolveContextWindow(config(undefined), provider, 'sonnet-4-5');
    expect(seenModel).toBe('sonnet-4-5');
    expect(result).toBe(800_000);
  });

  it('CAP-CONTEXT-WINDOW-001d: getEffectiveContextWindow returning undefined falls through to getContextWindow', () => {
    // Defensive pin: the strict type signature returns `number`, but the
    // cascade uses `??`, so a misbehaving custom provider that returns
    // undefined at runtime MUST still fall through. The cast bypasses the
    // type to exercise this off-spec runtime path.
    const provider = fakeProvider({
      getEffectiveContextWindow: (() => undefined) as unknown as (model?: string) => number,
      getContextWindow: () => 64_000,
    });
    expect(resolveContextWindow(config(undefined), provider, 'unknown-model')).toBe(64_000);
  });

  it('CAP-CONTEXT-WINDOW-001e: provider with neither getter falls through to DEFAULT_CONTEXT_WINDOW (200000)', () => {
    const bareProvider = fakeProvider();
    expect(bareProvider.getEffectiveContextWindow).toBeUndefined();
    expect(bareProvider.getContextWindow).toBeUndefined();
    expect(resolveContextWindow(config(undefined), bareProvider, undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(200_000);
  });

  it('CAP-CONTEXT-WINDOW-001f: config.contextWindow = 0 propagates as-is (nullish `??` does NOT treat 0 as a gap; load-bearing distinction from `||`)', () => {
    // The cascade uses `??`, so `0` would actually pass through as a
    // legitimate value. This pin documents the current behavior — if
    // the cascade ever switches to truthy-check, this test breaks
    // and forces a conscious decision.
    const provider = fakeProvider({
      getEffectiveContextWindow: () => 999_999,
    });
    expect(resolveContextWindow(config(0), provider, undefined)).toBe(0);
  });
});
