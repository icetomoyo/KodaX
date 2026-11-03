import { describe, expect, it } from 'vitest';
import type { KodaXReasoningProfile } from './types.js';
import {
  mapLegacyReasoningModeToEffortIntent,
  parseReasoningEffortEnv,
  resolveReasoningEffort,
  resolveReasoningEffortForModelSwitch,
  normalizeReasoningRequest,
} from './reasoning.js';

const openAiCapability: KodaXReasoningProfile = {
  effortStrategy: 'openai-chat-effort',
  defaultEffort: 'medium',
  supportedEfforts: [
    { value: 'none' },
    { value: 'minimal' },
    { value: 'low' },
    { value: 'medium', isDefault: true },
    { value: 'high' },
    { value: 'xhigh' },
  ],
  supportsReasoningEffort: true,
};

describe('reasoning effort resolver', () => {
  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'custom-effort'])(
    'preserves native effort %s at the legacy compatibility intake', effort => {
      expect(mapLegacyReasoningModeToEffortIntent(effort)).toBe(effort);
    });
  it('maps legacy reasoning modes to stable effort intent', () => {
    expect(mapLegacyReasoningModeToEffortIntent('off')).toBe('none');
    expect(mapLegacyReasoningModeToEffortIntent('auto')).toBe('auto');
    expect(mapLegacyReasoningModeToEffortIntent('quick')).toBe('low');
    expect(mapLegacyReasoningModeToEffortIntent('balanced')).toBe('medium');
    expect(mapLegacyReasoningModeToEffortIntent('deep')).toBe('high');
  });

  it('normalizes provider-specific effort as enabled reasoning', () => {
    expect(normalizeReasoningRequest({ effort: 'xhigh' })).toMatchObject({
      enabled: true,
      effort: 'xhigh',
    });
  });

  it('lets effort none disable reasoning even when legacy enabled flag is set', () => {
    expect(normalizeReasoningRequest({
      enabled: true,
      effort: 'none',
    })).toMatchObject({
      enabled: false,
      effort: 'none',
    });
  });

  it('distinguishes omitted reasoning from explicit legacy boolean controls', () => {
    expect(normalizeReasoningRequest(undefined).effortSource).toBe('omitted');
    expect(normalizeReasoningRequest(false).effortSource).toBe('legacy');
    expect(normalizeReasoningRequest({ enabled: false }).effortSource).toBe('legacy');
  });

  it('parses env effort override with auto and unset as clear values', () => {
    expect(parseReasoningEffortEnv(undefined)).toEqual({ kind: 'unset' });
    expect(parseReasoningEffortEnv('')).toEqual({ kind: 'unset' });
    expect(parseReasoningEffortEnv('auto')).toEqual({ kind: 'clear' });
    expect(parseReasoningEffortEnv('unset')).toEqual({ kind: 'clear' });
    expect(parseReasoningEffortEnv('off')).toEqual({ kind: 'value', value: 'none' });
    expect(parseReasoningEffortEnv(' HIGH ')).toEqual({ kind: 'value', value: 'high' });
  });

  it('uses explicit effort before session and model defaults', () => {
    const resolved = resolveReasoningEffort({
      capability: openAiCapability,
      explicitEffort: 'high',
      sessionEffort: 'low',
      legacyReasoningMode: 'balanced',
    });

    expect(resolved).toMatchObject({
      configuredEffort: 'high',
      effectiveEffort: 'high',
      source: 'explicit',
      isExplicit: true,
    });
  });

  it('uses explicit effort before env effort', () => {
    const resolved = resolveReasoningEffort({
      capability: openAiCapability,
      envEffort: 'low',
      explicitEffort: 'high',
      sessionEffort: 'medium',
    });

    expect(resolved).toMatchObject({
      configuredEffort: 'high',
      effectiveEffort: 'high',
      source: 'explicit',
      isExplicit: true,
    });
  });

  it('reports provider alias as effective effort while preserving configured effort', () => {
    const capability: KodaXReasoningProfile = {
      effortStrategy: 'openai-chat-effort',
      defaultEffort: 'high',
      supportedEfforts: [
        { value: 'low' },
        { value: 'medium' },
        { value: 'high', isDefault: true },
        { value: 'xhigh' },
        { value: 'max' },
      ],
      effortAliases: { low: 'high', medium: 'high', xhigh: 'max' },
    };

    expect(resolveReasoningEffort({
      capability,
      explicitEffort: 'low',
    })).toMatchObject({
      configuredEffort: 'low',
      effectiveEffort: 'high',
      source: 'explicit',
    });

    expect(resolveReasoningEffortForModelSwitch({
      currentEffort: 'xhigh',
      capability,
    })).toMatchObject({
      effectiveEffort: 'max',
      preserved: true,
    });
  });

  it('accepts aliases whose wire target is supported even when the alias key is hidden', () => {
    const capability: KodaXReasoningProfile = {
      effortStrategy: 'openai-chat-effort',
      defaultEffort: 'high',
      supportedEfforts: [
        { value: 'high', isDefault: true },
        { value: 'max' },
      ],
      effortAliases: { low: 'high', xhigh: 'max' },
    };

    expect(resolveReasoningEffort({
      capability,
      explicitEffort: 'low',
    })).toMatchObject({
      configuredEffort: 'low',
      effectiveEffort: 'high',
      source: 'explicit',
    });

    expect(resolveReasoningEffortForModelSwitch({
      currentEffort: 'xhigh',
      capability,
    })).toMatchObject({
      effectiveEffort: 'max',
      preserved: true,
    });
  });

  it('lets env auto clear only the env layer', () => {
    const resolved = resolveReasoningEffort({
      capability: openAiCapability,
      envEffort: 'auto',
      sessionEffort: 'high',
      legacyReasoningMode: 'balanced',
    });

    expect(resolved).toMatchObject({
      configuredEffort: 'high',
      effectiveEffort: 'high',
      source: 'session',
    });
  });

  it('rejects explicit unsupported provider-specific effort', () => {
    expect(() =>
      resolveReasoningEffort({
        capability: {
          effortStrategy: 'anthropic-output-effort',
          supportedEfforts: [
            { value: 'low' },
            { value: 'medium', isDefault: true },
            { value: 'high' },
          ],
        },
        explicitEffort: 'xhigh',
      }),
    ).toThrow('Unsupported reasoning effort "xhigh"');
  });

  it('honors local reject profiles before treating none as globally supported', () => {
    const alwaysOnCapability: KodaXReasoningProfile = {
      effortStrategy: 'prompt-only',
      defaultEffort: 'high',
      supportedEfforts: [{ value: 'high', isDefault: true }],
      localRejectEfforts: ['none', 'minimal'],
    };

    expect(() =>
      resolveReasoningEffort({
        capability: alwaysOnCapability,
        explicitEffort: 'none',
      }),
    ).toThrow('Unsupported reasoning effort "none"');

    expect(resolveReasoningEffortForModelSwitch({
      currentEffort: 'none',
      capability: alwaysOnCapability,
    })).toMatchObject({
      effectiveEffort: 'high',
      preserved: false,
      diagnostic: 'Effort none is not supported by the selected model; using high.',
    });
  });

  it('keeps model switch effort when supported and falls back visibly when not supported', () => {
    expect(resolveReasoningEffortForModelSwitch({
      currentEffort: 'high',
      capability: openAiCapability,
    })).toMatchObject({
      effectiveEffort: 'high',
      preserved: true,
    });

    expect(resolveReasoningEffortForModelSwitch({
      currentEffort: 'max',
      capability: openAiCapability,
    })).toMatchObject({
      effectiveEffort: 'medium',
      preserved: false,
      diagnostic: 'Effort max is not supported by the selected model; using medium.',
    });
  });
});
