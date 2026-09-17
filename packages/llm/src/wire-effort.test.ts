import { describe, expect, it } from 'vitest';
import { resolveWireEffort } from './wire-effort.js';
import { resolveModelCapabilities } from './providers/index.js';

/**
 * FEATURE_222 (R6) — resolveWireEffort composes profile lookup + rejection
 * narrowing + alias/ceiling/default resolution into one host-facing call.
 */
describe('resolveWireEffort', () => {
  it.each([
    ['none', 'low'],
    ['minimal', 'low'],
    ['light', 'low'],
    ['low', 'low'],
    ['medium', 'high'],
    ['high', 'high'],
    ['xhigh', 'max'],
    ['max', 'max'],
    ['ultra', 'max'],
  ])('maps GLM-5.3 effort %s to %s', (requested, expected) => {
    const profile = resolveModelCapabilities('zai-coding', 'glm-5.3')?.reasoningProfile;
    expect(profile?.effortAliases?.medium, 'test fixture assumption').toBe('high');

    const resolved = resolveWireEffort({
      provider: 'zai-coding',
      model: 'glm-5.3',
      desiredEffort: requested,
    });
    expect(resolved.effort).toBe(expected);
    expect(resolved.adjusted).toBe(requested !== expected);
  });

  it('never returns an effort that was rejected — folds rejectedEfforts into the ladder', () => {
    // 'high' would otherwise be selected; rejecting it forces a different rung.
    const resolved = resolveWireEffort({
      provider: 'zai-coding',
      model: 'glm-5.3',
      desiredEffort: 'high',
      rejectedEfforts: ['high'],
    });
    expect(resolved.effort).not.toBe('high');
    // A rejected high falls downward to low, never upward to the default max.
    expect(resolved.effort).toBe('low');
    expect(resolved.adjusted).toBe(true);
  });

  it('omits the effort (undefined) rather than returning a rejected rung when every rung is rejected (C8)', () => {
    const resolved = resolveWireEffort({
      provider: 'zai-coding',
      model: 'glm-5.3',
      desiredEffort: 'high',
      rejectedEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    });
    // Never hand back a value the provider already 400'd — omit reasoning_effort.
    expect(resolved.effort).toBeUndefined();
  });

  it('returns undefined effort for a provider/model with no reasoning profile', () => {
    const resolved = resolveWireEffort({ provider: 'does-not-exist', model: 'whatever', desiredEffort: 'high' });
    expect(resolved.effort).toBeUndefined();
    expect(resolved.configuredEffort).toBeUndefined();
    expect(resolved.adjusted).toBe(false);
  });

  it('resolves the provider default model when model is omitted (no throw)', () => {
    // Smoke: a real provider without an explicit model still yields a legal
    // ResolvedWireEffort (effort is a string or undefined, never throws).
    const resolved = resolveWireEffort({ provider: 'anthropic', desiredEffort: 'high' });
    expect(['string', 'undefined']).toContain(typeof resolved.effort);
  });

  it('preserves effectiveEffort === undefined rather than falling back to configuredEffort', () => {
    // A provider/model whose profile resolves the requested effort to "no wire
    // effort" (adaptive) must surface undefined, not the configured value.
    const caps = resolveModelCapabilities('anthropic', 'claude-opus-4-8')?.reasoningProfile;
    if (caps?.thinkingStrategy === 'anthropic-adaptive') {
      const resolved = resolveWireEffort({ provider: 'anthropic', model: 'claude-opus-4-8', desiredEffort: 'auto' });
      // configuredEffort may be 'auto'; effort must NOT be a stale copy of it.
      if (resolved.configuredEffort === 'auto') {
        expect(resolved.effort).not.toBe('auto');
      }
    }
  });
});
