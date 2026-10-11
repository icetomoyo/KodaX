/**
 * FEATURE_187 (v0.7.43) Phase B — Stall Sidecar provider resolution.
 *
 * Picks the (provider, model) pair the L2 stall sidecar calls. **Default
 * behaviour is inherit-from-main-agent** — the stall sidecar runs on the
 * same provider/model as the Main Agent unless explicitly overridden.
 * F178 eval `1909d5d2` validated SHIP-SIDECAR-ALL on 5 canonical aliases
 * all running inherit-main; that's the baseline the resolver defaults to.
 *
 * **Model decoupling is an opt-in escape hatch**: users who want to route
 * around a model quirk on a specific (provider, model) pair set the env
 * vars below to send the stall sidecar to a different family. Without
 * the override, sidecar uses the same model — same model = same floor;
 * the architecture provides the override mechanism, the user decides
 * whether to use it.
 *
 * Resolution order:
 *
 *   1. Explicit env override (both must be set):
 *        `KODAX_STALL_PROVIDER` + `KODAX_STALL_MODEL`
 *      Used verbatim — caller takes responsibility for the choice.
 *      If the provider name doesn't exist in the KodaX provider
 *      registry, the override is silently ignored and we fall through
 *      to step 2 (typos shouldn't silently break the sidecar — the L1
 *      anti-loop work is too valuable to disable on a config typo).
 *
 *   2. Inherit from Main Agent (default — always returns).
 *
 * The resolver **always returns a defined value** — the stall sidecar is
 * always installed in production.
 *
 * DI-clean: `env` parameter is injectable so unit tests don't mutate
 * `process.env`.
 *
 * Design references:
 *   - ADR-030 §1584 — FEATURE_187 placeholder origin
 *   - docs/features/v0.7.43.md §FEATURE_187 Phase B
 */

import {
  getProvider,
  isProviderName,
  type KodaXBaseProvider,
} from '@kodax-ai/llm';

/**
 * Outcome of stall sidecar provider resolution. `source` lets callers
 * log / surface telemetry distinguishing user-configured vs main-
 * inherited stall sidecar — useful for tracking "is the user opting
 * into a cross-family stall judgement or just inheriting main?" in
 * Phase C's opt-in `KODAX_STALL_LOG` output.
 */
export interface ResolvedStallSidecarProvider {
  readonly provider: KodaXBaseProvider;
  /** Resolved model id. `string` on the explicit-env path (env var
   *  required), `string | undefined` on the inherit-main path (the
   *  caller may have no specific main model configured — then the
   *  provider's registered default is used downstream). */
  readonly model: string | undefined;
  readonly providerName: string;
  readonly source: 'explicit-env' | 'inherit-main';
}

export const STALL_PROVIDER_ENV = 'KODAX_STALL_PROVIDER';
export const STALL_MODEL_ENV = 'KODAX_STALL_MODEL';

function tryGetProvider(name: string): KodaXBaseProvider | undefined {
  if (!isProviderName(name)) return undefined;
  try {
    return getProvider(name);
  } catch {
    return undefined;
  }
}

export interface ResolveStallSidecarProviderOptions {
  /** Main Agent's effective provider instance — used as the inherit
   *  fallback when no env override is set. Always required. */
  readonly mainProvider: KodaXBaseProvider;
  /** Main Agent's effective provider name (string id in the KodaX
   *  provider registry) — used as the inherit fallback. */
  readonly mainProviderName: string;
  /** Main Agent's effective model id — used as the inherit fallback.
   *  `undefined` is a legitimate value: the caller has no specific
   *  model configured and the provider's registered default should be
   *  used. The resolved `model` field will then also be `undefined`,
   *  which `invokeStallSidecar` short-circuits via
   *  `options.model ? {modelOverride} : undefined` (no `modelOverride`
   *  passed to `provider.stream`). DO NOT pass a placeholder like
   *  `'unknown'` — that is a truthy string and would defeat the guard. */
  readonly mainModel: string | undefined;
  /** Injectable env reader; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the stall sidecar provider per the 2-step order documented in
 * the file JSDoc. Always returns a defined value — the stall sidecar
 * hook is always installed in production.
 */
export function resolveStallSidecarProvider(
  options: ResolveStallSidecarProviderOptions,
): ResolvedStallSidecarProvider {
  const env = options.env ?? process.env;

  // 1. Explicit env override — both must be set to take effect.
  const explicitProvider = env[STALL_PROVIDER_ENV];
  const explicitModel = env[STALL_MODEL_ENV];
  if (explicitProvider && explicitModel) {
    const provider = tryGetProvider(explicitProvider);
    if (provider) {
      return {
        provider,
        model: explicitModel,
        providerName: explicitProvider,
        source: 'explicit-env',
      };
    }
    // Provider name unknown — silently fall through to inherit-main
    // (typos shouldn't break the stall sidecar; inherit-main is the
    // F178-eval-validated safe default).
  }

  // 2. Inherit from Main Agent.
  return {
    provider: options.mainProvider,
    model: options.mainModel,
    providerName: options.mainProviderName,
    source: 'inherit-main',
  };
}
