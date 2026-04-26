/**
 * Effective context-window resolver — CAP-056
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-056-effective-context-window-resolution-cascade
 *
 * Class 1 (substrate middleware). Pure four-step cascade evaluated at
 * the start of every turn (after per-turn provider re-resolution,
 * before the compaction trigger decision). The cascade order is
 * load-bearing — earlier sources override later ones:
 *
 *   1. **`compactionConfig.contextWindow`** (user-supplied) — wins
 *      unconditionally so an operator can pin a smaller window for
 *      cost / latency reasons even if the provider would advertise a
 *      larger one.
 *   2. **`provider.getEffectiveContextWindow?.(model)`** — model-
 *      specific window when the provider exposes it (e.g.
 *      `claude-3-5-sonnet-20241022` advertises 200000, while a
 *      provider with multiple models returns a per-model value).
 *   3. **`provider.getContextWindow?.()`** — provider-level default
 *      (used when the provider only exposes a single window).
 *   4. **`200000`** — hard fallback. Mirrors Anthropic's standard
 *      Claude window; safe default for providers that don't implement
 *      either capability check.
 *
 * The optional-chained calls are load-bearing — providers that don't
 * implement `getEffectiveContextWindow` / `getContextWindow` simply
 * skip to the next step in the cascade rather than throwing.
 *
 * P3 note: per inventory's stated migration target this module is
 * "shared with CAP-055" (per-turn provider re-resolution). CAP-055
 * lives inline in `runKodaX`'s for-loop today; once P3 substrate
 * adoption lands and the per-turn block lives inside the Runner
 * frame, both helpers will likely co-locate in
 * `per-turn-provider-resolution.ts`. For P2 this single-cascade
 * helper is the only piece tractable as a discrete extraction.
 *
 * Migration history: extracted from `agent.ts:1700-1703` —
 * pre-FEATURE_100 baseline — during FEATURE_100 P2.
 */

import type { KodaXBaseProvider } from '@kodax/ai';
import type { CompactionConfig } from '@kodax/agent';

/** Hard fallback. Mirrors Anthropic standard Claude window. */
export const DEFAULT_CONTEXT_WINDOW = 200000;

export function resolveContextWindow(
  compactionConfig: CompactionConfig,
  provider: KodaXBaseProvider,
  modelOverride: string | undefined,
): number {
  return compactionConfig.contextWindow
    ?? provider.getEffectiveContextWindow?.(modelOverride)
    ?? provider.getContextWindow?.()
    ?? DEFAULT_CONTEXT_WINDOW;
}
