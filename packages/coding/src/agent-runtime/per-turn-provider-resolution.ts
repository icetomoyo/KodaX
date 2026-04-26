/**
 * Per-turn provider / model / thinkingLevel re-resolution — CAP-055
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-055-per-turn-providermodelthinkinglevel-re-resolution
 *
 * Class 1 (substrate). Pure resolution evaluated at the start of every
 * turn (BEFORE compaction decision, BEFORE the provider stream). Reads
 * the live `runtimeSessionState` (extensions can mutate
 * `modelSelection` and `thinkingLevel` between turns) and the immutable
 * `options` to derive the canonical values used by the rest of the
 * iteration:
 *
 *   1. `providerName`  ← `sessionState.modelSelection.provider ?? options.provider`
 *   2. `modelOverride` ← `sessionState.modelSelection.model
 *                          ?? options.modelOverride ?? options.model`
 *   3. `thinkingLevel` ← `sessionState.thinkingLevel`
 *   4. `provider`      ← `resolveProvider(providerName)`
 *   5. `provider.isConfigured()` MUST return true (else throws with the
 *      canonical "set $API_KEY_ENV" error message — CAP-042 wire-up)
 *   6. `contextWindow` ← `resolveContextWindow(compactionConfig, provider, modelOverride)`
 *      (delegates to the CAP-056 cascade)
 *
 * The throw in step 5 is load-bearing: it mirrors agent.ts's
 * pre-FEATURE_100 baseline behavior where a mid-session provider
 * disable (e.g., `sessionState.modelSelection.provider` switched to a
 * provider whose API key was unset between turns) terminates the
 * session immediately rather than silently falling back.
 *
 * Migration history: extracted from `agent.ts:544-553` —
 * pre-FEATURE_100 baseline — during FEATURE_100 P3.1.
 */

import type { KodaXOptions, KodaXReasoningMode } from '../types.js';
import type { CompactionConfig } from '@kodax/agent';
import type { KodaXBaseProvider } from '@kodax/ai';
import { resolveProvider } from '../providers/index.js';
import { resolveContextWindow } from './context-window.js';
import type { RuntimeSessionState } from './runtime-session-state.js';

export interface PerTurnProviderResolution {
  readonly providerName: string;
  readonly modelOverride: string | undefined;
  readonly thinkingLevel: KodaXReasoningMode | undefined;
  readonly provider: KodaXBaseProvider;
  readonly contextWindow: number;
}

export function resolvePerTurnProvider(
  sessionState: RuntimeSessionState,
  options: KodaXOptions,
  compactionConfig: CompactionConfig,
): PerTurnProviderResolution {
  const providerName = sessionState.modelSelection.provider ?? options.provider;
  const modelOverride =
    sessionState.modelSelection.model ?? options.modelOverride ?? options.model;
  const thinkingLevel = sessionState.thinkingLevel;
  const provider = resolveProvider(providerName);
  if (!provider.isConfigured()) {
    throw new Error(
      `Provider "${providerName}" not configured. Set ${provider.getApiKeyEnv()}`,
    );
  }
  const contextWindow = resolveContextWindow(compactionConfig, provider, modelOverride);
  return { providerName, modelOverride, thinkingLevel, provider, contextWindow };
}
