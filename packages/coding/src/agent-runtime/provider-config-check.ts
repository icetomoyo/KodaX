/**
 * Provider configuration check — CAP-042
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-042-provider-configuration-check-entry--per-turn-re-validation
 *
 * Class 1 (substrate). Asserts that the resolved provider has its
 * required API key environment variable set before any LLM call. The
 * check fires at three sites in `runKodaX`:
 *
 *   1. Entry — immediately after the initial `resolveProvider` lookup,
 *      before any session-load / message-push work.
 *   2. Per-turn — after `applyPerTurnProviderResolution` produces the
 *      effective per-turn provider (handles runtime model overrides).
 *   3. Post-prepare-hook — after `applyProviderPrepareHook` may have
 *      switched the provider, before the actual `provider.stream` call.
 *
 * The error message is intentionally explicit about the missing
 * environment variable so users can self-resolve without consulting
 * docs (e.g. "Set KODAX_OPENAI_API_KEY").
 *
 * Migration history: extracted from `agent.ts:388-391, 697-699` —
 * pre-FEATURE_100 baseline — during FEATURE_100 P3.6n.
 */

import type { KodaXBaseProvider } from '@kodax/ai';

/**
 * CAP-042: throw if the provider lacks the API key env-var.
 *
 * The thrown error message includes BOTH the provider name (so users
 * know which provider failed) AND the env-var name (so users know
 * exactly what to set).
 */
export function assertProviderConfigured(
  provider: Pick<KodaXBaseProvider, 'isConfigured' | 'getApiKeyEnv'>,
  providerName: string,
): void {
  if (!provider.isConfigured()) {
    throw new Error(
      `Provider "${providerName}" not configured. Set ${provider.getApiKeyEnv()}`,
    );
  }
}
