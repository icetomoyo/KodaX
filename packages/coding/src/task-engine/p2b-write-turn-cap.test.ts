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
});
