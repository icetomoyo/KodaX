/**
 * P2b (v0.7.26) — unit test for the write-turn max_output_tokens cap
 * helper used by `buildRunnerLlmAdapter`. Verifies that:
 *
 *   - Only known-RST-prone providers trigger the cap
 *   - Only turns whose tool inventory contains write/edit/multi_edit trigger it
 *   - Explicit user override (`KODAX_MAX_OUTPUT_TOKENS`) always wins
 *   - The env-overridable provider list and cap value take effect
 *   - The cap is a no-op when the provider is already below the threshold
 *
 * Exercised via a stub provider whose getter/setter pair mirrors the real
 * `KodaXBaseProvider` contract. No network, no LLM — pure logic test.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

// Import the helper directly from the runner-driven module. It isn't
// exported in index.ts (internal detail), so pull via the compiled
// module import. We use a runtime require-style import to sidestep
// the "not exported" lint without tighter coupling.
import { maybeApplyP2bWriteTurnCap } from './runner-driven.js';

function loadHelper() {
  return maybeApplyP2bWriteTurnCap;
}

interface StubProvider {
  getEffectiveMaxOutputTokens(): number;
  setMaxOutputTokensOverride(v: number | undefined): void;
  override: number | undefined;
  baseline: number;
}

function makeStubProvider(baseline = 65_536): StubProvider {
  return {
    baseline,
    override: undefined,
    getEffectiveMaxOutputTokens(): number {
      return this.override ?? this.baseline;
    },
    setMaxOutputTokensOverride(v: number | undefined): void {
      this.override = v;
    },
  };
}

const originalEnv = { ...process.env };

beforeEach(() => {
  // Reset the two env vars we inspect.
  delete process.env.KODAX_MAX_OUTPUT_TOKENS;
  delete process.env.KODAX_RST_PRONE_PROVIDERS;
  delete process.env.KODAX_WRITE_TURN_MAX_TOKENS;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('P2b write-turn max_output_tokens cap', () => {
  it('applies the 8K cap when provider is RST-prone AND write tool is in scope', async () => {
    const fn = loadHelper();
    expect(fn).toBeDefined();
    const provider = makeStubProvider(65_536);
    const applied = fn(provider, 'zhipu-coding', [{ name: 'write' }, { name: 'read' }]);
    expect(applied).toBe(true);
    expect(provider.override).toBe(8192);
  });

  it('applies the cap when edit is the write-ish tool in scope', async () => {
    const fn = loadHelper();
    const provider = makeStubProvider(65_536);
    const applied = fn(provider, 'kimi-code', [{ name: 'edit' }]);
    expect(applied).toBe(true);
    expect(provider.override).toBe(8192);
  });

  it('applies the cap when multi_edit is in scope', async () => {
    const fn = loadHelper();
    const provider = makeStubProvider(65_536);
    const applied = fn(provider, 'minimax-coding', [{ name: 'multi_edit' }]);
    expect(applied).toBe(true);
    expect(provider.override).toBe(8192);
  });

  it('skips providers that are NOT on the RST-prone list', async () => {
    const fn = loadHelper();
    const provider = makeStubProvider(65_536);
    const applied = fn(provider, 'anthropic', [{ name: 'write' }]);
    expect(applied).toBe(false);
    expect(provider.override).toBeUndefined();
  });

  it('skips turns that do NOT include a write/edit/multi_edit tool', async () => {
    const fn = loadHelper();
    const provider = makeStubProvider(65_536);
    const applied = fn(provider, 'zhipu-coding', [
      { name: 'read' },
      { name: 'grep' },
      { name: 'bash' },
    ]);
    expect(applied).toBe(false);
    expect(provider.override).toBeUndefined();
  });

  it('respects KODAX_MAX_OUTPUT_TOKENS user override (skips the cap)', async () => {
    process.env.KODAX_MAX_OUTPUT_TOKENS = '32768';
    const fn = loadHelper();
    const provider = makeStubProvider(65_536);
    const applied = fn(provider, 'zhipu-coding', [{ name: 'write' }]);
    expect(applied).toBe(false);
    expect(provider.override).toBeUndefined();
  });

  it('respects KODAX_RST_PRONE_PROVIDERS custom list', async () => {
    process.env.KODAX_RST_PRONE_PROVIDERS = 'my-weird-provider,another';
    const fn = loadHelper();
    const provider = makeStubProvider(65_536);
    // Default RST-prone providers are NO LONGER recognized.
    expect(fn(provider, 'zhipu-coding', [{ name: 'write' }])).toBe(false);
    // The custom list IS recognized.
    const p2 = makeStubProvider(65_536);
    expect(fn(p2, 'my-weird-provider', [{ name: 'write' }])).toBe(true);
    expect(p2.override).toBe(8192);
  });

  it('respects KODAX_WRITE_TURN_MAX_TOKENS custom cap value', async () => {
    process.env.KODAX_WRITE_TURN_MAX_TOKENS = '4096';
    const fn = loadHelper();
    const provider = makeStubProvider(65_536);
    const applied = fn(provider, 'zhipu-coding', [{ name: 'write' }]);
    expect(applied).toBe(true);
    expect(provider.override).toBe(4096);
  });

  it('is a no-op when the provider is already at or below the cap', async () => {
    const fn = loadHelper();
    const provider = makeStubProvider(4096);
    const applied = fn(provider, 'zhipu-coding', [{ name: 'write' }]);
    expect(applied).toBe(false);
    expect(provider.override).toBeUndefined();
  });

  it('empty KODAX_RST_PRONE_PROVIDERS disables the cap entirely', async () => {
    process.env.KODAX_RST_PRONE_PROVIDERS = '';
    const fn = loadHelper();
    const provider = makeStubProvider(65_536);
    expect(fn(provider, 'zhipu-coding', [{ name: 'write' }])).toBe(false);
  });

  // MED-7: multi-turn persistence contract. The helper is stateless; it
  // makes decisions purely from the provider's current effective-tokens
  // state. These tests pin down what that implies across turns.

  it('MED-7: is idempotent when called twice in a row without caller cleanup', async () => {
    // Simulates a buggy caller that forgets to clear the override: the
    // second call must NOT further narrow the already-capped budget.
    const fn = loadHelper();
    const provider = makeStubProvider(65_536);

    const firstApplied = fn(provider, 'zhipu-coding', [{ name: 'write' }]);
    expect(firstApplied).toBe(true);
    expect(provider.override).toBe(8192);

    // No reset between calls — effective is now 8192 (== cap).
    const secondApplied = fn(provider, 'zhipu-coding', [{ name: 'write' }]);
    expect(secondApplied).toBe(false);
    expect(provider.override).toBe(8192); // unchanged
  });

  it('MED-7: re-applies on the next write-turn after caller clears the override', async () => {
    // Simulates the real adapter loop: finally-block clears override at
    // end of each adapter invocation, so the next write-turn sees the
    // baseline again and should re-apply the cap.
    const fn = loadHelper();
    const provider = makeStubProvider(65_536);

    expect(fn(provider, 'zhipu-coding', [{ name: 'write' }])).toBe(true);
    expect(provider.override).toBe(8192);

    // Mirror the real caller's finally-block cleanup.
    provider.setMaxOutputTokensOverride(undefined);
    expect(provider.override).toBeUndefined();

    expect(fn(provider, 'zhipu-coding', [{ name: 'write' }])).toBe(true);
    expect(provider.override).toBe(8192);
  });

  it('MED-7: a non-write turn between two write turns leaves the override untouched', async () => {
    // Real caller-level contract: non-write turns don't touch the
    // override at all. If a prior write turn left override=8192 (via a
    // bug in the caller's finally block) the non-write turn is a pure
    // no-op — it neither clears nor narrows.
    const fn = loadHelper();
    const provider = makeStubProvider(65_536);

    // Write turn 1: cap applied.
    expect(fn(provider, 'zhipu-coding', [{ name: 'write' }])).toBe(true);
    expect(provider.override).toBe(8192);

    // Intervening non-write turn (helper returns false, override stays).
    expect(fn(provider, 'zhipu-coding', [{ name: 'read' }, { name: 'bash' }])).toBe(false);
    expect(provider.override).toBe(8192);

    // Caller cleans up between adapter invocations.
    provider.setMaxOutputTokensOverride(undefined);

    // Write turn 2: cap applied again.
    expect(fn(provider, 'zhipu-coding', [{ name: 'edit' }])).toBe(true);
    expect(provider.override).toBe(8192);
  });

  it('MED-7: with a simulated active L4-escalation override (64K), a write turn still narrows to 8K', async () => {
    // Documents the intentional behavior: if a stale override from L4
    // escalation somehow survived into a new write-turn (it shouldn't,
    // but this pins the contract), the helper WILL narrow back to the
    // write-turn cap because `effective > cap`. Prevents accidental
    // regressions where someone changes the comparison direction.
    const fn = loadHelper();
    const provider = makeStubProvider(65_536);
    provider.setMaxOutputTokensOverride(64_000); // mimic L4 escalation leak

    const applied = fn(provider, 'zhipu-coding', [{ name: 'write' }]);
    expect(applied).toBe(true);
    expect(provider.override).toBe(8192);
  });
});
