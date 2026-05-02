/**
 * Classifier Model Resolver — FEATURE_092 Phase 2b.5 (v0.7.33).
 *
 * Determines which (provider, model) pair the auto-mode classifier should
 * call sideQuery against. Supports a 4-layer override chain (highest wins):
 *
 *   1. CLI flag         (--auto-classifier-model <spec>)
 *   2. Env var          (KODAX_AUTO_CLASSIFIER_MODEL)
 *   3. Session override (/auto-model <spec>)
 *   4. User settings    (~/.kodax/settings.json: autoMode.classifierModel)
 *
 * Falls back to the main session's (provider, model) when no override is
 * set — matching Claude Code's "use the same model you'd use for coding"
 * default. Spec format: "provider:model" or just "model" (provider then
 * inherits from the default-main).
 *
 * This module does NOT instantiate a KodaXBaseProvider — it returns names.
 * The actual provider lookup happens at the AutoModeToolGuardrail call site
 * (Phase 2b.6) so this module stays trivially testable without
 * provider-registry side effects.
 *
 * Capability check (provider.supportsAutoModeClassifier) is deferred to a
 * follow-up phase — extending FEATURE_029 capability profiles touches every
 * provider. For v1 the call simply fails fast at sideQuery time if the
 * provider can't stream text.
 */

export interface ParsedModelSpec {
  readonly providerName: string | null;
  readonly model: string;
}

export type ResolveSource =
  | 'cli'
  | 'env'
  | 'session-override'
  | 'user-settings'
  | 'default-main';

export interface ResolveClassifierModelOptions {
  readonly cliFlag?: string;
  readonly envVar?: string;
  readonly sessionOverride?: string;
  readonly userSettings?: string;
  readonly defaultProvider: string;
  readonly defaultModel: string;
}

export interface ResolvedClassifierModel {
  readonly providerName: string;
  readonly model: string;
  readonly source: ResolveSource;
}

export function parseModelSpec(spec: string): ParsedModelSpec {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new Error('parseModelSpec: empty spec');
  }
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) {
    return { providerName: null, model: trimmed };
  }
  const providerName = trimmed.slice(0, colonIdx).trim();
  const model = trimmed.slice(colonIdx + 1).trim();
  if (providerName.length === 0) {
    throw new Error(`parseModelSpec: provider name is empty in spec "${spec}"`);
  }
  if (model.length === 0) {
    throw new Error(`parseModelSpec: model name is empty in spec "${spec}"`);
  }
  return { providerName, model };
}

interface OverrideLayer {
  readonly source: ResolveSource;
  readonly value: string | undefined;
}

export function resolveClassifierModel(
  opts: ResolveClassifierModelOptions,
): ResolvedClassifierModel {
  const layers: OverrideLayer[] = [
    { source: 'cli', value: nonEmpty(opts.cliFlag) },
    { source: 'env', value: nonEmpty(opts.envVar) },
    { source: 'session-override', value: nonEmpty(opts.sessionOverride) },
    { source: 'user-settings', value: nonEmpty(opts.userSettings) },
  ];

  for (const layer of layers) {
    if (layer.value === undefined) continue;
    const parsed = parseModelSpec(layer.value);
    return {
      providerName: parsed.providerName ?? opts.defaultProvider,
      model: parsed.model,
      source: layer.source,
    };
  }

  return {
    providerName: opts.defaultProvider,
    model: opts.defaultModel,
    source: 'default-main',
  };
}

function nonEmpty(s: string | undefined): string | undefined {
  if (s === undefined || s === null) return undefined;
  return s.trim().length === 0 ? undefined : s;
}
