/**
 * Run-scoped config derivation — the single source of truth mapping the
 * per-run fields of `KodaXOptions` to the `KodaXRunScopedConfig` that the
 * llm / coding readers consult via AsyncLocalStorage (model-hint tiers,
 * provider max-output-tokens + prompt-cache, lsp, workflow concurrency).
 *
 * Both public SDK entries derive their ALS scope from this helper so no entry
 * can silently diverge: `runManagedTask` (the AMA Worker) AND `runKodaX`
 * (the blocking direct-engine entry that `startKodaX` wraps). Before this was shared,
 * `runKodaX` / `startKodaX` established no scope at all, so a consumer calling
 * `runKodaX({ modelTiers, maxOutputTokens, ... })` had every field silently
 * dropped — readers fell back to the shared `process.env`, breaking both the
 * documented SDK-over-env precedence and per-run isolation for concurrent
 * sessions (the very thing the ALS was introduced to fix).
 *
 * Only fields the caller actually set enter the store, so the CLI / config.json
 * path (single-session, env-bridged) is untouched — an empty object leaves
 * every reader on its env fallback.
 */
import type { KodaXRunScopedConfig } from '@kodax-ai/llm';

import type { KodaXOptions } from './types.js';

export function deriveRunScopedConfig(options: KodaXOptions): KodaXRunScopedConfig {
  return {
    ...(options.modelTiers !== undefined ? { modelTiers: options.modelTiers } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(options.disablePromptCache !== undefined
      ? { disablePromptCache: options.disablePromptCache }
      : {}),
    ...(options.lsp !== undefined ? { lsp: options.lsp } : {}),
    ...(options.workflow !== undefined ? { workflow: options.workflow } : {}),
  };
}
