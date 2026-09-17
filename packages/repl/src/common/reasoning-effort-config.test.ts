import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCapabilityCache,
  recordRejectedEffort,
  resetCapabilityCacheMemoForTesting,
  setAgentConfigHome,
} from '@kodax-ai/agent';
import {
  formatReasoningEffortForDisplay,
  formatReasoningEffortStatusLabel,
  getProviderReasoningEffortCycle,
  getProviderReasoningEffortOptions,
  resolveRuntimeEffortSelection,
  resolveRuntimeModelSelection,
  resolveRuntimeProviderSelection,
  resolveInitialEffortOverride,
  resolvePermissionModeEffort,
  resolveProviderReasoningRuntimeEffort,
} from './utils.js';

let tempHome = '';

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'kodax-reasoning-effort-config-'));
  setAgentConfigHome(tempHome);
  resetCapabilityCacheMemoForTesting();
});

afterEach(() => {
  resetCapabilityCacheMemoForTesting();
  setAgentConfigHome(undefined);
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = '';
  }
});

describe('resolveInitialEffortOverride', () => {
  it('restores override from a persisted config effort (Ctrl+T / /effort round-trip)', () => {
    expect(resolveInitialEffortOverride({}, { effort: 'high' })).toBe(true);
  });

  it('treats a CLI --effort flag as an override', () => {
    expect(resolveInitialEffortOverride({ effort: 'low' }, {})).toBe(true);
  });

  it('is not an override when neither CLI flag nor persisted effort exists (auto)', () => {
    expect(resolveInitialEffortOverride({}, {})).toBe(false);
  });

  it('treats a concrete environment effort as an override', () => {
    expect(resolveInitialEffortOverride({}, {}, 'high')).toBe(true);
  });

  it('does not treat the environment auto sentinel as an override', () => {
    expect(resolveInitialEffortOverride({}, {}, 'auto')).toBe(false);
  });
});

describe('runtime config selection', () => {
  it('uses explicit provider before environment, config, and default', () => {
    expect(resolveRuntimeProviderSelection({
      explicitProvider: 'cli',
      environmentProvider: 'env',
      configuredProvider: 'config',
      defaultProvider: 'default',
    })).toBe('cli');
  });

  it('uses environment provider before config', () => {
    expect(resolveRuntimeProviderSelection({
      environmentProvider: 'env',
      configuredProvider: 'config',
      defaultProvider: 'default',
    })).toBe('env');
  });

  it('does not carry a configured model across an environment provider switch', () => {
    expect(resolveRuntimeModelSelection({
      environmentProvider: 'anthropic',
      configuredProvider: 'openai',
      configuredModel: 'gpt-configured',
    })).toBeUndefined();
  });

  it('keeps a configured model when the environment provider matches', () => {
    expect(resolveRuntimeModelSelection({
      environmentProvider: 'openai',
      configuredProvider: 'openai',
      configuredModel: 'gpt-configured',
    })).toBe('gpt-configured');
  });

  it('uses explicit effort before environment and config', () => {
    expect(resolveRuntimeEffortSelection({
      explicitEffort: 'low',
      environmentEffort: 'high',
      configuredEffort: 'medium',
    })).toBe('low');
  });

  it('lets the environment auto sentinel fall back to config effort', () => {
    expect(resolveRuntimeEffortSelection({
      environmentEffort: 'auto',
      configuredEffort: 'medium',
    })).toBe('medium');
  });
});

describe('resolvePermissionModeEffort', () => {
  it('uses planModeEffort in plan mode when no session override exists', () => {
    expect(resolvePermissionModeEffort({
      effort: 'high',
      planModeEffort: 'medium',
      permissionMode: 'plan',
    })).toBe('medium');
  });

  it('lets explicit session effort override planModeEffort', () => {
    expect(resolvePermissionModeEffort({
      effort: 'high',
      effortOverride: true,
      planModeEffort: 'medium',
      permissionMode: 'plan',
    })).toBe('high');
  });

  it('treats planModeEffort none as an explicit plan-mode default', () => {
    expect(resolvePermissionModeEffort({
      effort: 'high',
      planModeEffort: 'none',
      permissionMode: 'plan',
    })).toBe('none');
  });

  it('falls back to global effort outside plan mode', () => {
    expect(resolvePermissionModeEffort({
      effort: 'high',
      planModeEffort: 'medium',
      permissionMode: 'accept-edits',
    })).toBe('high');
  });
});

describe('formatReasoningEffortStatusLabel', () => {
  it('shows the user-facing off label for internal none', () => {
    expect(formatReasoningEffortForDisplay('none')).toBe('off');
  });

  it('shows configured-to-effective auto defaults from the active model', () => {
    expect(formatReasoningEffortStatusLabel({
      provider: 'zhipu-coding',
      model: 'glm-5.2',
      effort: 'auto',
      effortOverride: true,
      thinking: true,
      reasoningMode: 'auto',
    })).toBe('auto->max');
  });

  it('shows provider aliases without changing the configured value', () => {
    expect(formatReasoningEffortStatusLabel({
      provider: 'zhipu-coding',
      model: 'glm-5.2',
      effort: 'xhigh',
      effortOverride: true,
      thinking: true,
      reasoningMode: 'auto',
    })).toBe('xhigh->max');
  });

  it('derives visible effort options from the active model capability', () => {
    expect(getProviderReasoningEffortOptions('zhipu-coding', 'glm-5.2'))
      .toEqual(['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(getProviderReasoningEffortOptions('openai', 'gpt-5.3-codex'))
      .toEqual(['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  });

  it('shows unsupported configured effort clamped to the active model', () => {
    expect(formatReasoningEffortStatusLabel({
      provider: 'openai',
      model: 'gpt-5.3-codex',
      effort: 'max',
      effortOverride: true,
      thinking: true,
      reasoningMode: 'auto',
    })).toBe('max->xhigh');
  });

  it('maps minimal to low for GLM-5.3', () => {
    expect(formatReasoningEffortStatusLabel({
      provider: 'zhipu-coding',
      model: 'glm-5.3',
      effort: 'minimal',
      effortOverride: true,
      thinking: true,
      reasoningMode: 'auto',
    })).toBe('minimal->low');
  });

  it('classifies GLM-5.3 off as low and hides the impossible off control', () => {
    const input = {
      provider: 'zhipu-coding',
      model: 'glm-5.3',
      effort: 'off',
      effortOverride: true,
      thinking: false,
      reasoningMode: 'off' as const,
    };

    expect(formatReasoningEffortStatusLabel(input)).toBe('off->low');
    expect(resolveProviderReasoningRuntimeEffort(input)).toMatchObject({
      configuredEffort: 'off',
      runtimeEffort: 'low',
    });
    expect(getProviderReasoningEffortOptions('zhipu-coding', 'glm-5.3'))
      .toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(getProviderReasoningEffortCycle('zhipu-coding', 'glm-5.3'))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
  });

  it('keeps minimal as a real tier where the model supports it (openai)', () => {
    expect(formatReasoningEffortStatusLabel({
      provider: 'openai',
      model: 'gpt-5.3-codex',
      effort: 'minimal',
      effortOverride: true,
      thinking: true,
      reasoningMode: 'auto',
    })).toBe('minimal');
  });

  it('narrows options from the persisted agent capability cache and restores after clear', () => {
    recordRejectedEffort('zhipu-coding', 'glm-5.2', 'max', 'observed', 'T0');

    expect(getProviderReasoningEffortOptions('zhipu-coding', 'glm-5.2'))
      .toEqual(['auto', 'off', 'low', 'medium', 'high', 'xhigh']);
    expect(formatReasoningEffortStatusLabel({
      provider: 'zhipu-coding',
      model: 'glm-5.2',
      effort: 'max',
      effortOverride: true,
      thinking: true,
      reasoningMode: 'auto',
    })).toBe('max->high');

    clearCapabilityCache('zhipu-coding', 'glm-5.2');
    expect(getProviderReasoningEffortOptions('zhipu-coding', 'glm-5.2'))
      .toEqual(['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('getProviderReasoningEffortCycle', () => {
  it('drops the minimal-folds-to-off duplicate and puts auto last (glm)', () => {
    expect(getProviderReasoningEffortCycle('zhipu-coding', 'glm-5.2'))
      .toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);
  });

  it('keeps minimal as a real rung where the model supports it (openai)', () => {
    expect(getProviderReasoningEffortCycle('openai', 'gpt-5.3-codex'))
      .toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'auto']);
  });
});

describe('resolveProviderReasoningRuntimeEffort', () => {
  it('keeps the configured effort while returning the model-safe runtime effort', () => {
    expect(resolveProviderReasoningRuntimeEffort({
      provider: 'openai',
      model: 'gpt-5.3-codex',
      effort: 'max',
      effortOverride: true,
      thinking: true,
      reasoningMode: 'auto',
    })).toMatchObject({
      configuredEffort: 'max',
      runtimeEffort: 'medium',
      preserved: false,
      diagnostic: 'Effort max is not supported by the selected model; using medium.',
    });
  });

  it('does not turn a plan-mode effort fallback into a session override', () => {
    expect(resolveProviderReasoningRuntimeEffort({
      provider: 'openai',
      model: 'gpt-5.3-codex',
      effort: 'high',
      planModeEffort: 'max',
      permissionMode: 'plan',
      thinking: true,
      reasoningMode: 'auto',
    })).toMatchObject({
      configuredEffort: 'max',
      runtimeEffort: 'medium',
      preserved: false,
    });
  });

  it('keeps custom provider effort values when no V2 capability is available', () => {
    expect(resolveProviderReasoningRuntimeEffort({
      provider: 'custom-no-v2',
      model: 'custom-model',
      effort: 'max',
      effortOverride: true,
    })).toMatchObject({
      configuredEffort: 'max',
      runtimeEffort: 'max',
      preserved: true,
    });
  });
});
