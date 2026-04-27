/**
 * FEATURE_104 (v0.7.29) — Canonical provider/model alias map for prompt evals.
 *
 * Why this exists:
 *   `tests/*.eval.ts` files prior to FEATURE_104 each copy-pasted their own
 *   `PROVIDERS` array with provider name, model id, and API-key env var. That
 *   pattern works but drifts: when a coding-plan model gets renamed (e.g.
 *   `glm-5` → `glm-5.1`, FEATURE_099) every eval file that hard-coded the
 *   old name has to be touched. Centralizing the alias map fixes drift and
 *   gives prompt-eval cases an ergonomic short id (`zhipu/glm51`,
 *   `ds/v4flash`, etc.).
 *
 * The alias short ids follow the user-supplied convention:
 *   'zhipu-coding/glm-5.1':         'zhipu/glm51'
 *   'kimi-code/kimi-for-coding':    'kimi'
 *   'mimo-coding/mimo-v2.5':        'mimo/v25'
 *   'mimo-coding/mimo-v2.5-pro':    'mimo/v25pro'
 *   'minimax-coding/MiniMax-M2.7':  'mmx/m27'
 *   'ark-coding/glm-5.1':           'ark/glm51'
 *   'deepseek/deepseek-v4-pro':     'ds/v4pro'
 *   'deepseek/deepseek-v4-flash':   'ds/v4flash'
 *
 * To add a new alias: extend `MODEL_ALIASES` below. Existing eval files
 * that still inline their own PROVIDERS arrays continue to work — migration
 * is opportunistic, not forced.
 */

export type ModelAlias =
  | 'zhipu/glm51'
  | 'kimi'
  | 'mimo/v25'
  | 'mimo/v25pro'
  | 'mmx/m27'
  | 'ark/glm51'
  | 'ds/v4pro'
  | 'ds/v4flash';

export interface ModelAliasTarget {
  /** KodaX provider name as it appears in the provider registry. */
  readonly provider: string;
  /** Model id as it appears in the provider's catalog. */
  readonly model: string;
  /** Environment variable that gates execution — eval skips when unset. */
  readonly apiKeyEnv: string;
}

export const MODEL_ALIASES: Readonly<Record<ModelAlias, ModelAliasTarget>> = Object.freeze({
  'zhipu/glm51':  { provider: 'zhipu-coding',   model: 'glm-5.1',           apiKeyEnv: 'ZHIPU_API_KEY' },
  'kimi':         { provider: 'kimi-code',      model: 'kimi-for-coding',   apiKeyEnv: 'KIMI_API_KEY' },
  'mimo/v25':     { provider: 'mimo-coding',    model: 'mimo-v2.5',         apiKeyEnv: 'MIMO_API_KEY' },
  'mimo/v25pro':  { provider: 'mimo-coding',    model: 'mimo-v2.5-pro',     apiKeyEnv: 'MIMO_API_KEY' },
  'mmx/m27':      { provider: 'minimax-coding', model: 'MiniMax-M2.7',      apiKeyEnv: 'MINIMAX_API_KEY' },
  'ark/glm51':    { provider: 'ark-coding',     model: 'glm-5.1',           apiKeyEnv: 'ARK_API_KEY' },
  'ds/v4pro':     { provider: 'deepseek',       model: 'deepseek-v4-pro',   apiKeyEnv: 'DEEPSEEK_API_KEY' },
  'ds/v4flash':   { provider: 'deepseek',       model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' },
});

export const ALL_MODEL_ALIASES: readonly ModelAlias[] = Object.freeze(
  Object.keys(MODEL_ALIASES) as ModelAlias[],
);

/**
 * Resolve the provider/model/env triple for a short alias. Throws on
 * unknown alias to surface typos at test-write time, not at run time.
 */
export function resolveAlias(alias: ModelAlias): ModelAliasTarget {
  const target = MODEL_ALIASES[alias];
  if (!target) {
    throw new Error(`Unknown model alias: "${alias}". Known: ${ALL_MODEL_ALIASES.join(', ')}`);
  }
  return target;
}

/**
 * Filter a list of aliases to only those whose API key is present in
 * `process.env`. Eval cases call this at suite setup so the suite can
 * skip gracefully (or `it.skipIf`) when no providers are configured.
 *
 * Defaults to all known aliases when called without arguments.
 */
export function availableAliases(...preferred: ModelAlias[]): ModelAlias[] {
  const candidates = preferred.length > 0 ? preferred : [...ALL_MODEL_ALIASES];
  return candidates.filter((alias) => {
    const env = MODEL_ALIASES[alias].apiKeyEnv;
    const value = process.env[env];
    return typeof value === 'string' && value.length > 0;
  });
}
