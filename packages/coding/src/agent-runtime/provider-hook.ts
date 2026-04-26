/**
 * Provider prepare hook — CAP-023
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-023-provider-prepare-hook-application
 *
 * Class 1 (substrate middleware). Fires the `provider:before`
 * extension hook BEFORE every `provider.stream` call, allowing
 * extensions to mutate the request envelope (provider name, model,
 * reasoning mode, system prompt) or block the call entirely (used by
 * provider-policy guards in the AMA evaluator path).
 *
 * The function operates on a copy of the input state — extensions
 * mutate the copy through the five exposed callbacks
 * (`replaceProvider`, `replaceModel`, `replaceSystemPrompt`,
 * `setThinkingLevel`, `block`); the original `ProviderPrepareState` is
 * never modified. This is load-bearing for the resilience-retry path
 * (CAP-031): each retry attempt re-runs `applyProviderPrepareHook`
 * with the original state, so an extension can return a different
 * decision per attempt without state bleed.
 *
 * The five callbacks correspond 1:1 to the contract in
 * `extensions/types.ts::ExtensionProviderBeforeHookContext`:
 *   - `block(reason)` → write `blockedReason` (substrate sees this and
 *     surfaces a structured block error before issuing the stream call).
 *   - `replaceProvider` / `replaceModel` / `replaceSystemPrompt` →
 *     mutate the request envelope.
 *   - `setThinkingLevel` → write `reasoningMode` (CAP-091 managed
 *     reasoning consults this for per-turn override).
 *
 * Time-ordering: AFTER history cleanup (CAP-002) so the hook sees the
 * canonicalised message buffer; BEFORE `provider.stream`.
 *
 * P3 note: when CAP-030 (`normalizeRuntimeModelSelection`) is
 * relocated from `runtime-session-state.ts` to this module per the
 * inventory's stated migration target, the per-turn model-selection
 * override will be canonicalised here in the same prepare-hook chain.
 *
 * Migration history: extracted from `agent.ts:146-152`
 * (`ProviderPrepareState` interface) + `agent.ts:1248-1275`
 * (`applyProviderPrepareHook`) — pre-FEATURE_100 baseline — during
 * FEATURE_100 P2.
 */

import type { KodaXReasoningMode } from '../types.js';
import { runActiveExtensionHook } from '../extensions/runtime.js';

export interface ProviderPrepareState {
  provider: string;
  model?: string;
  reasoningMode?: KodaXReasoningMode;
  systemPrompt: string;
  blockedReason?: string;
}

export async function applyProviderPrepareHook(
  state: ProviderPrepareState,
): Promise<ProviderPrepareState> {
  const mutableState: ProviderPrepareState = { ...state };

  await runActiveExtensionHook('provider:before', {
    provider: mutableState.provider,
    model: mutableState.model,
    reasoningMode: mutableState.reasoningMode,
    systemPrompt: mutableState.systemPrompt,
    block: (reason) => {
      mutableState.blockedReason = reason;
    },
    replaceProvider: (provider) => {
      mutableState.provider = provider;
    },
    replaceModel: (model) => {
      mutableState.model = model;
    },
    replaceSystemPrompt: (systemPrompt) => {
      mutableState.systemPrompt = systemPrompt;
    },
    setThinkingLevel: (level) => {
      mutableState.reasoningMode = level;
    },
  });

  return mutableState;
}
