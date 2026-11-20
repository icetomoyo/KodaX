/**
 * Run-scoped configuration via AsyncLocalStorage — concurrency-safe per-run
 * overrides for settings the coding / llm layers otherwise read from the global
 * `process.env` (the config→env bridge). Multiple SDK sessions run concurrently;
 * a global env var would let one session's config clobber another's. Each
 * `runManagedTask` wraps its run in `runWithScopedConfig(...)`, and every reader
 * checks `getRunScopedConfig()` first, falling back to `process.env` for the
 * CLI / config.json path (single-session, env-bridged) and legacy callers.
 *
 * Lives in the base @kodax-ai/llm layer so both the llm providers (max-output
 * tokens, prompt-cache) and the coding layer (model-hint tiers, LSP) can read it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface KodaXRunScopedConfig {
  readonly modelTiers?: {
    readonly fast?: { readonly provider?: string; readonly model?: string };
    readonly deep?: { readonly provider?: string; readonly model?: string };
  };
  readonly maxOutputTokens?: number;
  readonly disablePromptCache?: boolean;
  readonly lsp?: boolean;
  readonly workflow?: {
    /** Ceiling on concurrent workflow child agents (a run_workflow spawns). */
    readonly maxConcurrency?: number;
  };
  /**
   * The conversation this run belongs to. Provider HTTP requests carry it as
   * `X-Session-Id` so gateways can group a conversation across compaction.
   * Child agents share the root conversation's id.
   */
  readonly sessionId?: string;
}

/** Ids that are safe to place in an HTTP header: visible ASCII, no spaces, bounded. */
export function isWireSessionId(value: string): boolean {
  return /^[\x21-\x7E]{1,128}$/.test(value);
}

const store = new AsyncLocalStorage<KodaXRunScopedConfig>();

/** Default ceiling on concurrent workflow child agents. Eight leaves room for
 *  the main agent plus a sidecar verifier to stay near ~10 live agents total. */
export const WORKFLOW_MAX_CONCURRENCY_DEFAULT = 8;
/** Absolute safety ceiling so a stray config value can never uncap the fleet. */
export const WORKFLOW_MAX_CONCURRENCY_ABSOLUTE = 32;

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Effective ceiling on concurrent workflow child agents. Run-scoped config (the
 * SDK `KodaXOptions.workflow.maxConcurrency`) wins, then the
 * `KODAX_WORKFLOW_MAX_CONCURRENCY` env bridge (config.json / shell), then the
 * default of 8. Always clamped to `[1, WORKFLOW_MAX_CONCURRENCY_ABSOLUTE]` so a
 * malformed override can neither disable concurrency nor uncap the fleet.
 */
export function resolveWorkflowMaxConcurrency(): number {
  const scoped = getRunScopedConfig()?.workflow?.maxConcurrency;
  const chosen =
    typeof scoped === 'number' && Number.isInteger(scoped) && scoped > 0
      ? scoped
      : parsePositiveInt(process.env.KODAX_WORKFLOW_MAX_CONCURRENCY) ??
        WORKFLOW_MAX_CONCURRENCY_DEFAULT;
  return Math.max(1, Math.min(WORKFLOW_MAX_CONCURRENCY_ABSOLUTE, chosen));
}

/** Run `fn` with the given run-scoped config visible to `getRunScopedConfig()`
 *  for the entire (sync + async) call tree. Nesting replaces the inner scope. */
export function runWithScopedConfig<T>(config: KodaXRunScopedConfig, fn: () => T): T {
  return store.run(config, fn);
}

/** The current run's scoped config, or undefined outside any run (→ env fallback). */
export function getRunScopedConfig(): KodaXRunScopedConfig | undefined {
  return store.getStore();
}

/**
 * Resolve the effective prompt-cache disable switch without letting the
 * process-wide env override an explicit per-run choice. Callers that already
 * hold the public SDK option should pass it; provider code can omit it and
 * read the active AsyncLocalStorage scope instead.
 */
export function resolvePromptCacheDisabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  const scoped = getRunScopedConfig()?.disablePromptCache;
  if (scoped !== undefined) return scoped;
  return process.env.KODAX_DISABLE_PROMPT_CACHE === '1';
}
