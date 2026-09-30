/**
 * FEATURE_104 (v0.7.29) — Canonical provider/model alias map for prompt evals.
 *
 * Why this exists:
 *   `tests/*.eval.ts` files prior to FEATURE_104 each copy-pasted their own
 *   `PROVIDERS` array with provider name, model id, and API-key env var. That
 *   pattern works but drifts: when a coding-plan model gets renamed (e.g.
 *   `glm-5` → `glm-5.1`, FEATURE_099) every eval file that hard-coded the
 *   old name has to be touched. Centralizing the alias map fixes drift and
 *   gives prompt-eval cases an ergonomic short id (`zhipu/glm52`,
 *   `ds/v4flash`, etc.).
 *
 * The alias short ids follow the user-supplied convention:
 *   'zhipu-coding/glm-5.2':         'zhipu/glm52'
 *   'zhipu-coding/glm-5.1':         'zhipu/glm51' (legacy replay only)
 *   'zhipu-coding/glm-5.3-flash':   'zhipu/glm53flash' (explicit opt-in)
 *   'kimi-code/kimi-for-coding':    'kimi'
 *   'mimo-coding/mimo-v2.5':        'mimo/v25'
 *   'mimo-coding/mimo-v2.5-pro':    'mimo/v25pro'
 *   'minimax-coding/MiniMax-M3':    'mmx/m3'
 *   'minimax-coding/MiniMax-M2.7':  'mmx/m27' (legacy replay only)
 *   'ark-coding/glm-5.1':           'ark/glm51'
 *   'ark-coding/kimi-k2.7-code':    'ark/k27'
 *   'ark-coding/deepseek-v4-pro':   'ark/v4pro'
 *   'ark-coding/deepseek-v4-flash': 'ark/v4flash'
 *   'deepseek/deepseek-v4-pro':     'ds/v4pro'
 *   'deepseek/deepseek-v4-flash':   'ds/v4flash'
 *   'deepseek/deepseek-flash':      'ds/flash' (explicit opt-in)
 *
 * To add a new alias: extend `MODEL_ALIASES` below. Existing eval files
 * that still inline their own PROVIDERS arrays continue to work — migration
 * is opportunistic, not forced.
 *
 * **Canonical panel rule (2026-07-18)**: new prompt-evals default to the 5
 * coding-plan aliases — `zhipu/glm52`, `ark/k27`, `mmx/m3`, `ark/v4pro`,
 * `ark/v4flash`. The `ds/*` (deepseek official API) aliases stay in the
 * registry for legacy compatibility but should not be picked for new canonical
 * panels. `zhipu/glm51` and `mmx/m27` likewise remain resolvable only so frozen
 * historical experiments can be replayed without rewriting their provenance.
 */

export type ModelAlias =
  | 'zhipu/glm51'
  | 'zhipu/glm52'
  | 'zhipu/glm53flash'
  | 'kimi'
  | 'mimo/v25'
  | 'mimo/v25pro'
  | 'mmx/m27'
  | 'mmx/m3'
  | 'ark/glm51'
  | 'ark/k27'
  | 'ark/v4pro'
  | 'ark/v4flash'
  | 'ds/v4pro'
  | 'ds/v4flash'
  | 'ds/flash';

export interface ModelAliasTarget {
  /** KodaX provider name as it appears in the provider registry. */
  readonly provider: string;
  /** Model id as it appears in the provider's catalog. */
  readonly model: string;
  /** Environment variable that gates execution — eval skips when unset. */
  readonly apiKeyEnv: string;
  /** Optional eval scheduler policy. Default is one concurrent call per provider. */
  readonly evalConcurrency?: {
    readonly scope: 'model';
    readonly providerLimit: number;
  };
}

const ARK_MODEL_CONCURRENCY = Object.freeze({ scope: 'model', providerLimit: 3 } as const);

export const MODEL_ALIASES: Readonly<Record<ModelAlias, ModelAliasTarget>> = Object.freeze({
  'zhipu/glm51':  { provider: 'zhipu-coding',   model: 'glm-5.1',           apiKeyEnv: 'ZHIPU_CODING_API_KEY' },
  'zhipu/glm52':  { provider: 'zhipu-coding',   model: 'glm-5.2',           apiKeyEnv: 'ZHIPU_CODING_API_KEY' },
  'zhipu/glm53flash': { provider: 'zhipu-coding', model: 'glm-5.3-flash',   apiKeyEnv: 'ZHIPU_CODING_API_KEY' },
  'kimi':         { provider: 'kimi-code',      model: 'kimi-for-coding',   apiKeyEnv: 'KIMI_CODE_API_KEY' },
  'mimo/v25':     { provider: 'mimo-coding',    model: 'mimo-v2.5',         apiKeyEnv: 'MIMO_CODING_API_KEY' },
  'mimo/v25pro':  { provider: 'mimo-coding',    model: 'mimo-v2.5-pro',     apiKeyEnv: 'MIMO_CODING_API_KEY' },
  'mmx/m27':      { provider: 'minimax-coding', model: 'MiniMax-M2.7',      apiKeyEnv: 'MINIMAX_CODING_API_KEY' },
  'mmx/m3':       { provider: 'minimax-coding', model: 'MiniMax-M3',        apiKeyEnv: 'MINIMAX_CODING_API_KEY' },
  'ark/glm51':    { provider: 'ark-coding',     model: 'glm-5.1',           apiKeyEnv: 'ARK_CODING_API_KEY', evalConcurrency: ARK_MODEL_CONCURRENCY },
  'ark/k27':      { provider: 'ark-coding',     model: 'kimi-k2.7-code',    apiKeyEnv: 'ARK_CODING_API_KEY', evalConcurrency: ARK_MODEL_CONCURRENCY },
  'ark/v4pro':    { provider: 'ark-coding',     model: 'deepseek-v4-pro',   apiKeyEnv: 'ARK_CODING_API_KEY', evalConcurrency: ARK_MODEL_CONCURRENCY },
  'ark/v4flash':  { provider: 'ark-coding',     model: 'deepseek-v4-flash', apiKeyEnv: 'ARK_CODING_API_KEY', evalConcurrency: ARK_MODEL_CONCURRENCY },
  'ds/v4pro':     { provider: 'deepseek',       model: 'deepseek-v4-pro',   apiKeyEnv: 'DEEPSEEK_API_KEY' },
  'ds/v4flash':   { provider: 'deepseek',       model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  'ds/flash':     { provider: 'deepseek',       model: 'deepseek-flash',    apiKeyEnv: 'DEEPSEEK_API_KEY' },
});

export const ALL_MODEL_ALIASES: readonly ModelAlias[] = Object.freeze(
  Object.keys(MODEL_ALIASES) as ModelAlias[],
);

/** Default cross-family pool for every newly authored or revised eval. */
export const DEFAULT_EVAL_ALIASES = Object.freeze([
  'zhipu/glm52',
  'ark/k27',
  'mmx/m3',
  'ark/v4pro',
  'ark/v4flash',
] as const satisfies readonly ModelAlias[]);

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

export interface EvalConcurrencyPolicy {
  readonly provider: string;
  readonly lane: string;
  readonly providerLimit: number;
}

/** Resolve the bounded eval lane without coupling the harness to provider names. */
export function resolveEvalConcurrency(alias: ModelAlias): EvalConcurrencyPolicy {
  const target = resolveAlias(alias);
  return {
    provider: target.provider,
    lane: target.evalConcurrency?.scope === 'model'
      ? `${target.provider}/${target.model}`
      : target.provider,
    providerLimit: target.evalConcurrency?.providerLimit ?? 1,
  };
}

/**
 * Filter a list of aliases to only those whose API key is present in
 * `process.env`. Eval cases call this at suite setup so the suite can
 * skip gracefully (or `it.skipIf`) when no providers are configured.
 *
 * Defaults to the canonical current pool when called without arguments.
 * Legacy aliases remain available only when explicitly requested.
 */
export function availableAliases(...preferred: ModelAlias[]): ModelAlias[] {
  const candidates = preferred.length > 0 ? preferred : [...DEFAULT_EVAL_ALIASES];
  return candidates.filter((alias) => {
    const env = MODEL_ALIASES[alias].apiKeyEnv;
    const value = process.env[env];
    return typeof value === 'string' && value.length > 0;
  });
}
