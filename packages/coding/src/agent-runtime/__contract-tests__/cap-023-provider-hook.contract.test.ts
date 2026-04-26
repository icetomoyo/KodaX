/**
 * Contract test for CAP-023: provider prepare hook application
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-023-provider-prepare-hook-application
 *
 * Test obligations:
 * - CAP-PROVIDER-HOOK-001: extension prepare hook can override model selection
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/provider-hook.ts (extracted from
 * agent.ts:146-152 + 1248-1275 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: AFTER history cleanup (CAP-002); BEFORE
 * provider.stream.
 *
 * Active here: the five-callback contract on the `provider:before`
 * hook payload (`block`, `replaceProvider`, `replaceModel`,
 * `replaceSystemPrompt`, `setThinkingLevel`) and the load-bearing
 * input-immutability invariant (the original `ProviderPrepareState`
 * is never mutated; the function operates on a copy).
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  KodaXExtensionRuntime,
  setActiveExtensionRuntime,
} from '../../extensions/runtime.js';
import {
  type ProviderPrepareState,
  applyProviderPrepareHook,
} from '../provider-hook.js';

function freshState(): ProviderPrepareState {
  return {
    provider: 'anthropic',
    model: 'claude-original',
    reasoningMode: 'balanced',
    systemPrompt: 'original prompt',
  };
}

describe('CAP-023: applyProviderPrepareHook — five callbacks + immutability', () => {
  let runtime: KodaXExtensionRuntime;

  beforeEach(() => {
    runtime = new KodaXExtensionRuntime();
    setActiveExtensionRuntime(runtime);
  });

  afterEach(async () => {
    setActiveExtensionRuntime(null);
    await runtime.dispose();
  });

  it('CAP-PROVIDER-HOOK-001a: replaceProvider + replaceModel override the request envelope (the documented obligation)', async () => {
    runtime.registerHook('provider:before', (ctx) => {
      ctx.replaceProvider('openai');
      ctx.replaceModel('gpt-override');
    });

    const result = await applyProviderPrepareHook(freshState());
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-override');
  });

  it('CAP-PROVIDER-HOOK-001b: replaceSystemPrompt overrides the system prompt', async () => {
    runtime.registerHook('provider:before', (ctx) => {
      ctx.replaceSystemPrompt('replaced prompt');
    });

    const result = await applyProviderPrepareHook(freshState());
    expect(result.systemPrompt).toBe('replaced prompt');
  });

  it('CAP-PROVIDER-HOOK-001c: setThinkingLevel writes through to reasoningMode', async () => {
    runtime.registerHook('provider:before', (ctx) => {
      ctx.setThinkingLevel('deep');
    });

    const result = await applyProviderPrepareHook(freshState());
    expect(result.reasoningMode).toBe('deep');
  });

  it('CAP-PROVIDER-HOOK-001d: block(reason) sets blockedReason on the returned state', async () => {
    runtime.registerHook('provider:before', (ctx) => {
      ctx.block('policy: lossy bridge provider');
    });

    const result = await applyProviderPrepareHook(freshState());
    expect(result.blockedReason).toBe('policy: lossy bridge provider');
    // Other fields stay intact — block is signal-only, not a clear.
    expect(result.provider).toBe('anthropic');
  });

  it('CAP-PROVIDER-HOOK-IMMUTABILITY: original state object is NOT mutated (function operates on a copy)', async () => {
    runtime.registerHook('provider:before', (ctx) => {
      ctx.replaceProvider('mutated-provider');
      ctx.replaceModel('mutated-model');
      ctx.replaceSystemPrompt('mutated-prompt');
      ctx.setThinkingLevel('deep');
      ctx.block('blocked');
    });

    const original = freshState();
    const result = await applyProviderPrepareHook(original);

    // Original is untouched
    expect(original.provider).toBe('anthropic');
    expect(original.model).toBe('claude-original');
    expect(original.systemPrompt).toBe('original prompt');
    expect(original.reasoningMode).toBe('balanced');
    expect(original.blockedReason).toBeUndefined();

    // But the returned state reflects the hook
    expect(result.provider).toBe('mutated-provider');
    expect(result.blockedReason).toBe('blocked');
  });

  it('CAP-PROVIDER-HOOK-NO-RUNTIME: with no active runtime, the function returns a clone of the input unchanged (no-op)', async () => {
    setActiveExtensionRuntime(null);
    const result = await applyProviderPrepareHook(freshState());
    expect(result).toEqual(freshState());
  });

  it('CAP-PROVIDER-HOOK-NO-HOOK: with active runtime but no `provider:before` hook registered, returns a clone unchanged', async () => {
    const result = await applyProviderPrepareHook(freshState());
    expect(result).toEqual(freshState());
  });
});
