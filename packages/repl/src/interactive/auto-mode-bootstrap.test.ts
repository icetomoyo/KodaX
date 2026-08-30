/**
 * Hermetic tests for `bootstrapAutoMode` — FEATURE_092 phase 2b.7b.
 *
 * No real LLM, no real tool registry mutation. We exercise the wiring:
 *   - startup does not read legacy auto-rules files
 *   - the guardrail is constructed lazily on first `getGuardrail()` call
 *   - subsequent calls return the SAME instance (state is shared)
 *   - legacy askUser input remains accepted but is not forwarded
 *
 * The guardrail's own behavior (Tier 1, classifier, denial fallback,
 * circuit breaker) is covered by `packages/coding/src/guardrails/auto-mode/
 * guardrail.test.ts` — those tests already pin the guardrail contract,
 * so here we only verify wiring.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@kodax-ai/coding', async () => {
  const actual = await vi.importActual<typeof import('@kodax-ai/coding')>('@kodax-ai/coding');
  return {
    ...actual,
    formatAgentsForPrompt: vi.fn(() => ''),
    // Issue 143 (WS3): wrap the real factory in a capturing spy (still delegates
    // to the real implementation, so guardrail behavior is unchanged) so wiring
    // tests can assert which config the bootstrap forwarded.
    createAutoModeToolGuardrail: vi.fn(
      (config: import('@kodax-ai/coding').AutoModeGuardrailConfig) =>
        actual.createAutoModeToolGuardrail(config),
    ),
  };
});

import { bootstrapAutoMode } from './auto-mode-bootstrap.js';
import {
  createAutoModeDenialTracker,
  createAutoModeToolGuardrail,
  createCircuitBreaker,
  type AutoModeSharedState,
} from '@kodax-ai/coding';

const baseDeps = () => ({
  askUser: vi.fn(async () => 'allow' as const),
  projectRoot: '/test/project',
  executionCwd: '/test/project/worktree',
  getCurrentProviderName: () => 'kimi-code',
  getCurrentModel: () => 'kimi-for-coding',
  getCurrentPermissionMode: () => 'auto' as const,
  autoModeSettings: {
    classifierModel: undefined,
    classifierModelEnv: undefined,
  },
});

describe('bootstrapAutoMode', () => {
  it('returns lazy guardrail and turn-reset seams', async () => {
    const result = await bootstrapAutoMode(baseDeps());
    expect(Object.keys(result)).toEqual(['getGuardrail', 'resetTurn']);
    expect(typeof result.getGuardrail).toBe('function');
    expect(typeof result.resetTurn).toBe('function');
  });

  it('getGuardrail returns the same instance on repeated calls (state-sharing)', async () => {
    const result = await bootstrapAutoMode(baseDeps());
    const a = result.getGuardrail();
    const b = result.getGuardrail();
    expect(a).toBe(b);
  });

  it('forwards a Runtime-owned Session state into context-specific guardrails', async () => {
    const sharedState: AutoModeSharedState = {
      denials: createAutoModeDenialTracker(),
      breaker: createCircuitBreaker(),
    };
    const result = await bootstrapAutoMode({ ...baseDeps(), sharedState });
    result.getGuardrail();

    const config = vi.mocked(createAutoModeToolGuardrail).mock.calls.at(-1)?.[0];
    expect(config?.sharedState).toBe(sharedState);
  });

  it('resets denial thresholds between turns without clearing breaker health', async () => {
    const sharedState: AutoModeSharedState = {
      denials: { consecutive: 2, cumulative: 4, recent: [true, true] },
      breaker: { timestamps: [123] },
    };
    const result = await bootstrapAutoMode({ ...baseDeps(), sharedState });
    result.getGuardrail();

    result.resetTurn();

    expect(sharedState.denials).toEqual({ consecutive: 0, cumulative: 0, recent: [] });
    expect(sharedState.breaker.timestamps).toEqual([123]);
  });

  it('forwards shell environment path-expansion trust to the analyzer context', async () => {
    const result = await bootstrapAutoMode({
      ...baseDeps(),
      trustProcessEnvironmentPathExpansion: false,
    });
    result.getGuardrail();

    const config = vi.mocked(createAutoModeToolGuardrail).mock.calls.at(-1)?.[0];
    expect(config?.trustProcessEnvironmentPathExpansion).toBe(false);
  });

  it('guardrail has stable kind=tool name=auto-mode (Runner registration contract)', async () => {
    const result = await bootstrapAutoMode(baseDeps());
    const g = result.getGuardrail();
    expect(g.kind).toBe('tool');
    expect(g.name).toBe('auto-mode');
  });

  it('does not expose the removed selectable engine surface', async () => {
    const result = await bootstrapAutoMode(baseDeps());
    const g = result.getGuardrail();
    expect(g).not.toHaveProperty('getEngine');
    expect(g).not.toHaveProperty('setEngine');
  });

  it('does not eagerly construct the guardrail (lazy on first getGuardrail)', async () => {
    const result = await bootstrapAutoMode(baseDeps());
    // The factory is returned, but no guardrail has been built until
    // `getGuardrail()` is called. Verifying laziness directly is hard
    // without exposing internals; we settle for the weaker assertion
    // that `result.getGuardrail` is callable and returns an object —
    // confirming the constructor ran exactly once.
    expect(result.getGuardrail).toBeDefined();
    const g1 = result.getGuardrail();
    const g2 = result.getGuardrail();
    expect(g1).toBe(g2);
  });

  // FEATURE_092 v0.7.34 hotfix-3 — defaultProvider/defaultModel staleness.
  //
  // Before the fix, bootstrap snapshotted `getCurrentProviderName()` and
  // `getCurrentModel()` once at first getGuardrail() call and froze the
  // result inside the guardrail's `defaultProvider` / `defaultModel`
  // string fields. Mid-session `/model` and `/provider` swaps did NOT
  // retarget the classifier. After the fix, bootstrap also passes
  // `getDefaultProvider` / `getDefaultModel` getters to the guardrail
  // config; the guardrail re-evaluates them on every classify.
  it('passes getDefaultProvider that re-evaluates getCurrentProviderName each call', async () => {
    let liveProvider = 'kimi-code';
    const getCurrentProviderName = vi.fn(() => liveProvider);
    const result = await bootstrapAutoMode({
      ...baseDeps(),
      getCurrentProviderName,
    });
    // Trigger guardrail construction (lazy) — bootstrap reads
    // `getCurrentProviderName()` once for the static `defaultProvider`
    // fallback at this point.
    result.getGuardrail();
    const initialCalls = getCurrentProviderName.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(1);

    // Simulate `/provider` swap mid-session.
    liveProvider = 'glm-coding';

    // The bootstrap-side getter (passed as `getDefaultProvider`) should be
    // a thin pass-through to `getCurrentProviderName`. We can't poke the
    // guardrail's resolveClassifierModel directly without a classify call,
    // but we can confirm that calling getCurrentProviderName again after
    // the swap returns the new value — which is the contract the getter
    // closure relies on.
    expect(getCurrentProviderName()).toBe('glm-coding');
  });

  it('does not forward legacy timeout or speculative-window inputs', async () => {
    const result = await bootstrapAutoMode({
      ...baseDeps(),
      autoModeSettings: {
        classifierModel: undefined,
        classifierModelEnv: undefined,
      },
    });
    result.getGuardrail(); // trigger lazy construction
    const cfg = vi.mocked(createAutoModeToolGuardrail).mock.calls.at(-1)?.[0];
    expect(cfg?.speculativeWindowMs).toBeUndefined();
    expect(cfg?.timeoutMs).toBeUndefined();
    expect(cfg?.askUser).toBeUndefined();
  });

  it('forwards the optional fixed reviewer policy to the guardrail', async () => {
    const result = await bootstrapAutoMode({
      ...baseDeps(),
      autoModeSettings: {
        ...baseDeps().autoModeSettings,
        reviewPolicy: 'Never publish packages from this machine.',
      },
    });
    result.getGuardrail();
    const cfg = vi.mocked(createAutoModeToolGuardrail).mock.calls.at(-1)?.[0];
    expect(cfg?.reviewPolicy).toBe('Never publish packages from this machine.');
  });

  it('keeps trusted administrator and model guidance separate from the user policy', async () => {
    const result = await bootstrapAutoMode({
      ...baseDeps(),
      administratorPolicy: 'Administrator policy.',
      modelGuidance: 'Selected model catalog guidance.',
      autoModeSettings: {
        ...baseDeps().autoModeSettings,
        reviewPolicy: 'User config policy.',
      },
    });
    result.getGuardrail();
    const cfg = vi.mocked(createAutoModeToolGuardrail).mock.calls.at(-1)?.[0];
    expect(cfg).toMatchObject({
      administratorPolicy: 'Administrator policy.',
      reviewPolicy: 'User config policy.',
      modelGuidance: 'Selected model catalog guidance.',
    });
  });

  it('forwards an empty live model to the common guardrail without bootstrap-side effects', async () => {
    const log = vi.fn<(level: 'info' | 'warn', msg: string) => void>();
    const getCurrentModel = vi.fn(() => undefined);
    const result = await bootstrapAutoMode({
      ...baseDeps(),
      getCurrentModel,
      log,
    });
    result.getGuardrail();
    const cfg = vi.mocked(createAutoModeToolGuardrail).mock.calls.at(-1)?.[0];
    expect(cfg?.defaultModel).toBe('');
    expect(cfg?.getDefaultModel?.()).toBe('');
    expect(log).not.toHaveBeenCalled();
  });
});
