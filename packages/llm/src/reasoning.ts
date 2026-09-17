import {
  KodaXNormalizedReasoningRequest,
  KodaXProviderConfig,
  KodaXReasoningProfile,
  KodaXReasoningEffortPreset,
  KodaXReasoningPresetName,
  KodaXReasoningCapability,
  KodaXReasoningMode,
  KodaXReasoningRequest,
  KodaXStableEffortIntent,
  KodaXTaskType,
  KodaXWireReasoningEffort,
  KodaXThinkingBudgetMap,
  KodaXThinkingDepth,
} from './types.js';
import { buildReasoningEffortLadder, usesReasoningEffortLadder } from './reasoning-ladder.js';

export const KODAX_REASONING_MODE_SEQUENCE: KodaXReasoningMode[] = [
  'off',
  'auto',
  'quick',
  'balanced',
  'deep',
];

export const KODAX_STABLE_EFFORT_INTENTS: KodaXStableEffortIntent[] = [
  'auto',
  'none',
  'low',
  'medium',
  'high',
];

export const KODAX_DEFAULT_THINKING_BUDGETS: KodaXThinkingBudgetMap = {
  low: 6000,
  medium: 10000,
  high: 20000,
};

export const KODAX_REASONING_SAFETY_RESERVE = 4096;

const ENABLED_TOGGLE_EFFORTS: readonly KodaXReasoningEffortPreset[] = [
  { value: 'none', description: 'Disable thinking' },
  { value: 'minimal', description: 'Disable thinking', isUserVisible: false },
  { value: 'low', description: 'Enable thinking' },
  { value: 'medium', description: 'Enable thinking', isDefault: true },
  { value: 'high', description: 'Enable thinking' },
  { value: 'xhigh', description: 'Enable thinking' },
  { value: 'max', description: 'Enable thinking' },
];

const HIGH_MAX_EFFORTS: readonly KodaXReasoningEffortPreset[] = [
  { value: 'none', description: 'Disable thinking' },
  { value: 'minimal', description: 'Disable thinking', isUserVisible: false },
  { value: 'low', description: 'Alias to high' },
  { value: 'medium', description: 'Alias to high' },
  { value: 'high', description: 'High reasoning', isDefault: true },
  { value: 'xhigh', description: 'Alias to max' },
  { value: 'max', description: 'Maximum reasoning' },
];

const DEEPSEEK_V4_FLASH_EFFORTS: readonly KodaXReasoningEffortPreset[] = [
  { value: 'none', description: 'Disable thinking' },
  { value: 'minimal', description: 'Disable thinking', isUserVisible: false },
  { value: 'low', description: 'Low reasoning' },
  { value: 'medium', description: 'Alias to high' },
  { value: 'high', description: 'High reasoning', isDefault: true },
  { value: 'xhigh', description: 'Alias to high' },
  { value: 'max', description: 'Maximum reasoning' },
];

const ALWAYS_ON_EFFORTS: readonly KodaXReasoningEffortPreset[] = [
  { value: 'low', description: 'Thinking is always on' },
  { value: 'medium', description: 'Thinking is always on' },
  { value: 'high', description: 'Thinking is always on', isDefault: true },
  { value: 'xhigh', description: 'Thinking is always on' },
  { value: 'max', description: 'Thinking is always on' },
];

export function createReasoningProfileFromPreset(
  preset: KodaXReasoningPresetName,
  overrides: Partial<KodaXReasoningProfile> = {},
): KodaXReasoningProfile {
  const base = createBaseReasoningProfileFromPreset(preset);
  return {
    ...base,
    ...overrides,
    reasoningPreset: preset,
  };
}

function createBaseReasoningProfileFromPreset(
  preset: KodaXReasoningPresetName,
): KodaXReasoningProfile {
  switch (preset) {
    case 'zai-glm-5.3':
      return {
        reasoningPreset: preset,
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'max',
        supportedEfforts: [
          { value: 'none', description: 'Maps to low reasoning' },
          { value: 'minimal', description: 'Alias to low', isUserVisible: false },
          { value: 'low', description: 'Low reasoning' },
          { value: 'medium', description: 'Alias to high' },
          { value: 'high', description: 'High reasoning' },
          { value: 'xhigh', description: 'Alias to max' },
          { value: 'max', description: 'Maximum reasoning', isDefault: true },
        ],
        effortAliases: {
          none: 'low',
          minimal: 'low',
          minimum: 'low',
          light: 'low',
          medium: 'high',
          xhigh: 'max',
          ultra: 'max',
        },
        disabledEfforts: ['none'],
        supportsReasoningEffort: true,
        supportsDisabledThinking: false,
      };
    case 'zai-glm-5.2':
      return {
        reasoningPreset: preset,
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'max',
        supportedEfforts: HIGH_MAX_EFFORTS,
        effortAliases: { low: 'high', medium: 'high', xhigh: 'max' },
        disabledEfforts: ['none', 'minimal'],
        supportsReasoningEffort: true,
        supportsDisabledThinking: true,
      };
    case 'deepseek-v4-flash-openai':
      return {
        reasoningPreset: preset,
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'high',
        supportedEfforts: DEEPSEEK_V4_FLASH_EFFORTS,
        effortAliases: { medium: 'high', xhigh: 'high' },
        disabledEfforts: ['none', 'minimal'],
        supportsReasoningEffort: true,
        supportsDisabledThinking: true,
      };
    // Unknown-model legacy configs preserve their historical Pro-like
    // mapping. Custom providers with a known Flash/Pro model id migrate to the
    // corresponding explicit preset before reaching this factory.
    case 'deepseek-v4-openai':
    case 'deepseek-v4-pro-openai':
      return {
        reasoningPreset: preset,
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'high',
        supportedEfforts: HIGH_MAX_EFFORTS,
        effortAliases: { low: 'high', medium: 'high', xhigh: 'max' },
        disabledEfforts: ['none', 'minimal'],
        supportsReasoningEffort: true,
        supportsDisabledThinking: true,
      };
    case 'deepseek-v4-anthropic':
      return {
        reasoningPreset: preset,
        effortStrategy: 'anthropic-output-effort',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'high',
        supportedEfforts: HIGH_MAX_EFFORTS,
        effortAliases: { low: 'high', medium: 'high', xhigh: 'max' },
        disabledEfforts: ['none', 'minimal'],
        supportsReasoningEffort: true,
        supportsDisabledThinking: true,
      };
    case 'zai-glm-toggle':
    case 'deepseek-toggle':
    case 'kimi-hybrid-toggle':
    case 'mimo-v2.5-toggle':
    case 'generic-thinking-toggle':
      return {
        reasoningPreset: preset,
        effortStrategy: 'provider-toggle',
        thinkingStrategy: 'provider-toggle',
        supportedEfforts: ENABLED_TOGGLE_EFFORTS,
        disabledEfforts: ['none', 'minimal'],
        supportsDisabledThinking: true,
      };
    case 'kimi-k3':
      return {
        reasoningPreset: preset,
        effortStrategy: 'provider-toggle',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'high',
        supportedEfforts: [
          { value: 'none', description: 'Disable thinking' },
          { value: 'low', description: 'Low thinking effort' },
          { value: 'high', description: 'High thinking effort', isDefault: true },
          { value: 'max', description: 'Maximum thinking effort' },
        ],
        effortAliases: {
          minimal: 'low',
          minimum: 'low',
          light: 'low',
          medium: 'high',
          xhigh: 'max',
          ultra: 'max',
        },
        disabledEfforts: ['none'],
        supportsReasoningEffort: true,
        supportsDisabledThinking: true,
      };
    case 'kimi-k2.7-code':
    case 'minimax-m2-always':
      return {
        reasoningPreset: preset,
        effortStrategy: 'prompt-only',
        defaultEffort: 'high',
        supportedEfforts: ALWAYS_ON_EFFORTS,
        localRejectEfforts: ['none', 'minimal'],
      };
    case 'minimax-m3':
      return {
        reasoningPreset: preset,
        effortStrategy: 'provider-toggle',
        thinkingStrategy: 'anthropic-adaptive',
        supportedEfforts: ENABLED_TOGGLE_EFFORTS,
        disabledEfforts: ['none', 'minimal'],
        supportsAdaptiveThinking: true,
        supportsDisabledThinking: true,
      };
    case 'qwen-hybrid-thinking':
      return {
        reasoningPreset: preset,
        effortStrategy: 'provider-budget',
        thinkingStrategy: 'provider-budget',
        defaultEffort: 'medium',
        supportedEfforts: ENABLED_TOGGLE_EFFORTS,
        budgetByEffort: {
          low: 6000,
          medium: 10000,
          high: 16000,
          xhigh: 24000,
          max: 32000,
        },
        disabledEfforts: ['none', 'minimal'],
        supportsManualThinkingBudget: true,
        supportsDisabledThinking: true,
      };
    case 'claude-adaptive-xhigh':
      return {
        reasoningPreset: preset,
        effortStrategy: 'anthropic-output-effort',
        thinkingStrategy: 'anthropic-adaptive',
        defaultEffort: 'high',
        supportedEfforts: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high', isDefault: true },
          { value: 'xhigh' },
          { value: 'max' },
        ],
        supportsReasoningEffort: true,
        supportsAdaptiveThinking: true,
      };
    case 'claude-adaptive-max':
      return {
        reasoningPreset: preset,
        effortStrategy: 'anthropic-output-effort',
        thinkingStrategy: 'anthropic-adaptive',
        defaultEffort: 'high',
        supportedEfforts: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high', isDefault: true },
          { value: 'max' },
        ],
        supportsReasoningEffort: true,
        supportsAdaptiveThinking: true,
      };
    case 'anthropic-budget':
      return {
        reasoningPreset: preset,
        effortStrategy: 'provider-budget',
        thinkingStrategy: 'anthropic-budget',
        defaultEffort: 'medium',
        supportedEfforts: [
          { value: 'none' },
          { value: 'low' },
          { value: 'medium', isDefault: true },
          { value: 'high' },
        ],
        budgetByEffort: {
          low: 6000,
          medium: 10000,
          high: 16000,
        },
        disabledEfforts: ['none'],
        supportsManualThinkingBudget: true,
        supportsDisabledThinking: true,
      };
    case 'openai-chat-reasoning':
    case 'openai-responses-reasoning':
      return {
        reasoningPreset: preset,
        effortStrategy: preset === 'openai-chat-reasoning'
          ? 'openai-chat-effort'
          : 'openai-responses-effort',
        defaultEffort: 'medium',
        supportedEfforts: [
          { value: 'none' },
          { value: 'minimal' },
          { value: 'low' },
          { value: 'medium', isDefault: true },
          { value: 'high' },
          { value: 'xhigh' },
        ],
        disabledEfforts: ['none'],
        supportsReasoningEffort: true,
        supportsReasoningSummary: true,
        supportsEncryptedReasoningReplay: true,
      };
    case 'codex-cli-effort':
      return {
        reasoningPreset: preset,
        effortStrategy: 'codex-cli-config',
        defaultEffort: 'medium',
        supportedEfforts: [
          { value: 'none' },
          { value: 'minimal' },
          { value: 'low' },
          { value: 'medium', isDefault: true },
          { value: 'high' },
          { value: 'xhigh' },
        ],
        allowCustomEffort: true,
        supportsReasoningEffort: true,
      };
    case 'none':
      return {
        reasoningPreset: preset,
        effortStrategy: 'none',
        thinkingStrategy: 'none',
      };
  }
}

export function getReasoningCapability(
  config: KodaXProviderConfig,
): KodaXReasoningCapability {
  if (config.reasoningCapability) {
    return config.reasoningCapability;
  }

  return config.supportsThinking ? 'native-toggle' : 'prompt-only';
}

export function isReasoningEnabled(
  reasoning?: boolean | KodaXReasoningRequest,
): boolean {
  return normalizeReasoningRequest(reasoning).enabled;
}

export function normalizeReasoningRequest(
  reasoning?: boolean | KodaXReasoningRequest,
): KodaXNormalizedReasoningRequest {
  if (typeof reasoning === 'boolean') {
    return {
      enabled: reasoning,
      effort: reasoning ? 'auto' : 'none',
      effortSource: 'legacy',
      taskType: 'unknown',
      executionMode: 'implementation',
    };
  }

  // Reasoning single-tracking: effort is the sole control. An explicit effort
  // wins; otherwise the legacy `enabled` boolean shorthand maps to auto/none.
  const explicitEffort = reasoning?.effort
    ? normalizeReasoningEffortValue(reasoning.effort)
    : undefined;
  const effort: KodaXWireReasoningEffort =
    explicitEffort
    ?? (reasoning?.enabled === true ? 'auto' : 'none');

  return {
    enabled: effort !== 'none',
    effort,
    effortSource: explicitEffort !== undefined
      ? 'explicit'
      : reasoning === undefined
        ? 'omitted'
        : 'legacy',
    taskType: reasoning?.taskType ?? 'unknown',
    executionMode: reasoning?.executionMode ?? 'implementation',
  };
}

export type KodaXReasoningEffortEnvOverride =
  | { kind: 'unset' }
  | { kind: 'clear' }
  | { kind: 'value'; value: KodaXWireReasoningEffort };

export type KodaXReasoningEffortSource =
  | 'env'
  | 'explicit'
  | 'session'
  | 'legacy'
  | 'model-default'
  | 'provider-default'
  | 'fallback';

export interface KodaXResolvedReasoningEffort {
  readonly configuredEffort: KodaXWireReasoningEffort;
  readonly effectiveEffort?: KodaXWireReasoningEffort;
  readonly source: KodaXReasoningEffortSource;
  readonly isExplicit: boolean;
  readonly diagnostics: readonly string[];
}

export interface KodaXResolveReasoningEffortInput {
  readonly capability?: KodaXReasoningProfile;
  readonly envEffort?: string;
  readonly explicitEffort?: string;
  readonly sessionEffort?: string;
  readonly legacyReasoningMode?: KodaXReasoningMode;
  readonly thinking?: boolean;
  readonly modelDefaultEffort?: string;
  readonly providerDefaultEffort?: string;
  readonly fallbackEffort?: string;
}

export interface KodaXModelSwitchEffortResolution {
  readonly effectiveEffort?: KodaXWireReasoningEffort;
  readonly preserved: boolean;
  readonly diagnostic?: string;
}

interface EffortCandidate {
  readonly value: string;
  readonly source: KodaXReasoningEffortSource;
  readonly isExplicit: boolean;
}

export function normalizeReasoningEffortValue(
  value: string,
): KodaXWireReasoningEffort {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Reasoning effort cannot be empty.');
  }
  if (/\s/.test(normalized)) {
    throw new Error(`Reasoning effort cannot contain whitespace: "${value}".`);
  }
  if (normalized === 'off') {
    return 'none';
  }
  return normalized;
}

export function mapLegacyReasoningModeToEffortIntent(
  mode: KodaXReasoningMode,
): KodaXStableEffortIntent {
  switch (mode) {
    case 'off':
      return 'none';
    case 'auto':
      return 'auto';
    case 'quick':
      return 'low';
    case 'balanced':
      return 'medium';
    case 'deep':
      return 'high';
  }
}

export function effortToLegacyReasoningMode(
  effort: string | undefined,
): KodaXReasoningMode | undefined {
  switch (effort) {
    case 'none':
      return 'off';
    case 'auto':
      return 'auto';
    case 'low':
      return 'quick';
    case 'medium':
      return 'balanced';
    case 'high':
      return 'deep';
    default:
      return undefined;
  }
}

export function parseReasoningEffortEnv(
  raw: string | undefined,
): KodaXReasoningEffortEnvOverride {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { kind: 'unset' };
  }
  const value = normalizeReasoningEffortValue(trimmed);
  if (value === 'auto' || value === 'unset') {
    return { kind: 'clear' };
  }
  return { kind: 'value', value };
}

export function resolveReasoningEffort(
  input: KodaXResolveReasoningEffortInput,
): KodaXResolvedReasoningEffort {
  const env = parseReasoningEffortEnv(input.envEffort);
  const candidates: EffortCandidate[] = [];

  pushEffortCandidate(candidates, input.explicitEffort, 'explicit', true);
  if (env.kind === 'value') {
    candidates.push({ value: env.value, source: 'env', isExplicit: true });
  }
  pushEffortCandidate(candidates, input.sessionEffort, 'session', false);
  if (input.legacyReasoningMode) {
    candidates.push({
      value: mapLegacyReasoningModeToEffortIntent(input.legacyReasoningMode),
      source: 'legacy',
      isExplicit: false,
    });
  } else if (input.thinking !== undefined) {
    candidates.push({
      value: input.thinking ? 'auto' : 'none',
      source: 'legacy',
      isExplicit: false,
    });
  }
  if (usesReasoningEffortLadder(input.capability)) {
    const first = candidates[0] ?? { value: 'auto', source: 'fallback' as const, isExplicit: false };
    const profile = { ...input.capability, defaultEffort: input.modelDefaultEffort
      ?? input.capability.defaultEffort ?? getDefaultPresetValue(input.capability)
      ?? input.providerDefaultEffort ?? input.fallbackEffort };
    const effectiveEffort = buildReasoningEffortLadder(profile, first.value)[0];
    return { configuredEffort: first.value, effectiveEffort, source: first.source,
      isExplicit: first.isExplicit, diagnostics: [] };
  }
  pushEffortCandidate(
    candidates,
    input.modelDefaultEffort ?? input.capability?.defaultEffort ?? getDefaultPresetValue(input.capability),
    'model-default',
    false,
  );
  pushEffortCandidate(candidates, input.providerDefaultEffort, 'provider-default', false);
  pushEffortCandidate(
    candidates,
    input.fallbackEffort ?? getFallbackEffortForCapability(input.capability),
    'fallback',
    false,
  );

  const first = candidates[0] ?? {
    value: 'none',
    source: 'fallback' as const,
    isExplicit: false,
  };

  if (first.value === 'auto') {
    const effective = resolveAutoEffectiveEffort(candidates.slice(1), input.capability);
    return {
      configuredEffort: 'auto',
      effectiveEffort: effective,
      source: first.source,
      isExplicit: first.isExplicit,
      diagnostics: [],
    };
  }

  const effectiveEffort = validateReasoningEffort(first.value, input.capability, first.isExplicit);
  return {
    configuredEffort: first.value,
    effectiveEffort,
    source: first.source,
    isExplicit: first.isExplicit,
    diagnostics: [],
  };
}

export function resolveReasoningEffortForModelSwitch(input: {
  readonly currentEffort: string | undefined;
  readonly capability?: KodaXReasoningProfile;
}): KodaXModelSwitchEffortResolution {
  const currentEffort = input.currentEffort
    ? normalizeReasoningEffortValue(input.currentEffort)
    : undefined;
  if (currentEffort && isSupportedReasoningEffort(currentEffort, input.capability)) {
    return {
      effectiveEffort: applyEffortAlias(currentEffort, input.capability),
      preserved: true,
    };
  }

  const fallbackRaw =
    input.capability?.defaultEffort ??
    getDefaultPresetValue(input.capability) ??
    getMiddleVisiblePresetValue(input.capability) ??
    getFallbackEffortForCapability(input.capability);
  const fallback = fallbackRaw
    ? applyEffortAlias(fallbackRaw, input.capability)
    : fallbackRaw;

  if (!currentEffort) {
    return { effectiveEffort: fallback, preserved: false };
  }

  return {
    effectiveEffort: fallback,
    preserved: false,
    diagnostic: fallback
      ? `Effort ${currentEffort} is not supported by the selected model; using ${fallback}.`
      : `Effort ${currentEffort} is not supported by the selected model; clearing effort.`,
  };
}

function pushEffortCandidate(
  candidates: EffortCandidate[],
  rawValue: string | undefined,
  source: KodaXReasoningEffortSource,
  isExplicit: boolean,
): void {
  if (rawValue === undefined) {
    return;
  }
  const value = normalizeReasoningEffortValue(rawValue);
  candidates.push({ value, source, isExplicit });
}

function resolveAutoEffectiveEffort(
  candidates: readonly EffortCandidate[],
  capability: KodaXReasoningProfile | undefined,
): KodaXWireReasoningEffort | undefined {
  const concreteCandidate = candidates.find((candidate) => candidate.value !== 'auto');
  if (concreteCandidate) {
    return validateReasoningEffort(
      concreteCandidate.value,
      capability,
      concreteCandidate.isExplicit,
    );
  }
  return getDefaultPresetValue(capability) ?? getFallbackEffortForCapability(capability);
}

function validateReasoningEffort(
  effort: KodaXWireReasoningEffort,
  capability: KodaXReasoningProfile | undefined,
  isExplicit: boolean,
): KodaXWireReasoningEffort {
  if (capability?.localRejectEfforts?.includes(effort)) {
    if (isExplicit) {
      throw new Error(
        `Unsupported reasoning effort "${effort}" for the selected model.`
      );
    }
    return getDefaultPresetValue(capability)
      ?? getMiddleVisiblePresetValue(capability)
      ?? getFallbackEffortForCapability(capability)
      ?? effort;
  }
  if (effort === 'none') {
    return capability?.supportsDisabledThinking === false
      ? applyEffortAlias(effort, capability)
      : effort;
  }
  if (isSupportedReasoningEffort(effort, capability)) {
    return applyEffortAlias(effort, capability);
  }
  if (isExplicit) {
    throw new Error(
      `Unsupported reasoning effort "${effort}" for the selected model.`
    );
  }
  return getDefaultPresetValue(capability)
    ?? getMiddleVisiblePresetValue(capability)
    ?? getFallbackEffortForCapability(capability)
    ?? effort;
}

function applyEffortAlias(
  effort: KodaXWireReasoningEffort,
  capability: KodaXReasoningProfile | undefined,
): KodaXWireReasoningEffort {
  return capability?.effortAliases?.[effort] ?? effort;
}

function isSupportedReasoningEffort(
  effort: KodaXWireReasoningEffort,
  capability: KodaXReasoningProfile | undefined,
): boolean {
  if (capability?.localRejectEfforts?.includes(effort)) {
    return false;
  }
  if (effort === 'auto' || effort === 'none') {
    return true;
  }
  if (capability?.allowCustomEffort === true) {
    return true;
  }
  const supported = getSupportedEffortValues(capability);
  if (supported.length === 0) {
    return KODAX_STABLE_EFFORT_INTENTS.includes(effort as KodaXStableEffortIntent);
  }
  return supported.includes(effort) || supported.includes(applyEffortAlias(effort, capability));
}

function getSupportedEffortValues(
  capability: KodaXReasoningProfile | undefined,
): readonly KodaXWireReasoningEffort[] {
  return capability?.supportedEfforts?.map((preset) => preset.value) ?? [];
}

function getDefaultPresetValue(
  capability: KodaXReasoningProfile | undefined,
): KodaXWireReasoningEffort | undefined {
  return capability?.supportedEfforts?.find((preset) => preset.isDefault)?.value;
}

function getMiddleVisiblePresetValue(
  capability: KodaXReasoningProfile | undefined,
): KodaXWireReasoningEffort | undefined {
  const visible = capability?.supportedEfforts
    ?.filter(isUserVisiblePreset)
    .map((preset) => preset.value);
  if (!visible || visible.length === 0) {
    return undefined;
  }
  return visible[Math.floor((visible.length - 1) / 2)];
}

function isUserVisiblePreset(preset: KodaXReasoningEffortPreset): boolean {
  return preset.isUserVisible !== false;
}

function getFallbackEffortForCapability(
  capability: KodaXReasoningProfile | undefined,
): KodaXWireReasoningEffort | undefined {
  if (!capability || capability.effortStrategy === 'none' || capability.effortStrategy === 'prompt-only') {
    return 'none';
  }
  if (capability.effortStrategy === 'anthropic-output-effort' && capability.thinkingStrategy === 'anthropic-adaptive') {
    return undefined;
  }
  return 'medium';
}

export function getDefaultThinkingDepthForMode(
  mode: KodaXReasoningMode,
): KodaXThinkingDepth {
  switch (mode) {
    case 'quick':
      return 'low';
    case 'balanced':
    case 'auto':
      return 'medium';
    case 'deep':
      return 'high';
    case 'off':
    default:
      return 'off';
  }
}

/**
 * Map a canonical effort onto a thinking-budget tier. Reasoning single-tracking
 * keeps `KodaXThinkingDepth` as a pure internal *budget-size* enum (no longer a
 * reasoning-control track): provider budget resolution keys off this instead of
 * a separate depth field on the request. The mapping mirrors the legacy
 * effort→mode→depth derivation `normalizeReasoningRequest` used, so the emitted
 * `thinking.budget_tokens` / `reasoning_effort` wire values are unchanged:
 *   none → off | low → low | medium/auto → medium |
 *   high/xhigh/max/minimal/custom → high.
 */
export function effortToThinkingDepth(
  effort: KodaXWireReasoningEffort | undefined,
): KodaXThinkingDepth {
  switch (effort) {
    case 'none':
      return 'off';
    case 'low':
      return 'low';
    case undefined:
    case 'medium':
    case 'auto':
      return 'medium';
    default:
      return 'high';
  }
}

export function resolveThinkingBudget(
  config: KodaXProviderConfig,
  depth: KodaXThinkingDepth,
  taskType: KodaXTaskType = 'unknown',
): number {
  if (depth === 'off') {
    return 0;
  }

  const defaultBudgets: KodaXThinkingBudgetMap = {
    ...KODAX_DEFAULT_THINKING_BUDGETS,
    ...(config.defaultThinkingBudgets ?? {}),
  };

  const taskOverride = config.taskBudgetOverrides?.[taskType];
  const requestedBudget = taskOverride?.[depth] ?? defaultBudgets[depth];

  if (config.thinkingBudgetCap) {
    return Math.min(requestedBudget, config.thinkingBudgetCap);
  }

  return requestedBudget;
}

export function clampThinkingBudget(
  requestedBudget: number,
  maxOutputTokens: number,
  safetyReserve = KODAX_REASONING_SAFETY_RESERVE,
): number {
  const hardCap = Math.max(1024, maxOutputTokens - safetyReserve);
  return Math.max(1024, Math.min(requestedBudget, hardCap));
}

export function mapDepthToOpenAIReasoningEffort(
  depth: KodaXThinkingDepth,
): 'low' | 'medium' | 'high' | undefined {
  switch (depth) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    default:
      return undefined;
  }
}
