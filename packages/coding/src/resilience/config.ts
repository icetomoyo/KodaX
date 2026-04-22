/**
 * KodaX Resilience Config (Feature 045)
 *
 * Resolves effective resilience configuration by merging
 * defaults, global config, and per-provider overrides.
 */

import type {
  ProviderResilienceConfig,
  ProviderResiliencePolicy,
} from './types.js';

// ============== Default Values ==============

/**
 * Default resilience configuration values.
 * These are used when no explicit config is provided.
 */
export const DEFAULT_RESILIENCE_CONFIG: Required<ProviderResilienceConfig> = {
  requestTimeoutMs: 600_000,       // 10 minutes hard timeout
  // Stream idle timeout: DISABLED by default (0 = off), aligned with Claude Code
  // which also keeps its watchdog off by default.  The 10-minute hard timeout is
  // sufficient to catch genuinely stuck connections.  Enabling an aggressive idle
  // timer causes false positives with slow providers (e.g. Zhipu) that go silent
  // between content blocks while generating large tool_use payloads.
  //
  // To enable: set KODAX_STREAM_IDLE_TIMEOUT_MS env var or streamIdleTimeoutMs
  // in ~/.kodax/config.json (value in milliseconds, e.g. 90000 for 90s).
  streamIdleTimeoutMs: Number(process.env.KODAX_STREAM_IDLE_TIMEOUT_MS) || 0,
  chunkTimeoutMs: 30_000,          // 30 seconds per-chunk timeout
  maxRetries: 4,                   // Up to 4 automatic retries (attempt 2 reserved for
                                   // non-streaming fallback; keeps one more tier for
                                   // stable_boundary_retry after fallback also fails)
  maxRetryDelayMs: 60_000,         // Cap retry delay at 60s
  enableNonStreamingFallback: true, // Allow non-streaming fallback by default
};

// ============== Config Resolution ==============

/**
 * Resolves the effective resilience configuration for a given provider.
 *
 * Merge order (later wins):
 * 1. Built-in defaults
 * 2. Global config (from KodaXOptions or config file)
 * 3. Per-provider policy override (exact provider name match)
 *
 * @param providerName - The provider to resolve config for
 * @param globalConfig - Optional global override
 * @param perProvider - Optional per-provider policy list
 * @returns Fully resolved config with all fields populated
 */
export function resolveResilienceConfig(
  providerName: string,
  globalConfig?: ProviderResilienceConfig,
  perProvider?: ProviderResiliencePolicy[],
): Required<ProviderResilienceConfig> {
  // Start with defaults
  const result = { ...DEFAULT_RESILIENCE_CONFIG };

  // Layer 1: Global config overrides
  if (globalConfig) {
    mergePartialConfig(result, globalConfig);
  }

  // Layer 2: Per-provider policy (find exact match)
  if (perProvider && perProvider.length > 0) {
    const policy = perProvider.find(p => p.provider === providerName);
    if (policy) {
      const { provider: _provider, ...policyConfig } = policy;
      mergePartialConfig(result, policyConfig);
    }
  }

  return result;
}

// ============== Helpers ==============

/**
 * Merges partial config fields into a fully-populated config object.
 * Only fields that are explicitly set (not undefined) are applied.
 */
function mergePartialConfig(
  target: Required<ProviderResilienceConfig>,
  partial: ProviderResilienceConfig,
): void {
  if (partial.requestTimeoutMs !== undefined) {
    target.requestTimeoutMs = partial.requestTimeoutMs;
  }
  if (partial.streamIdleTimeoutMs !== undefined) {
    target.streamIdleTimeoutMs = partial.streamIdleTimeoutMs;
  }
  if (partial.chunkTimeoutMs !== undefined) {
    target.chunkTimeoutMs = partial.chunkTimeoutMs;
  }
  if (partial.maxRetries !== undefined) {
    target.maxRetries = partial.maxRetries;
  }
  if (partial.maxRetryDelayMs !== undefined) {
    target.maxRetryDelayMs = partial.maxRetryDelayMs;
  }
  if (partial.enableNonStreamingFallback !== undefined) {
    target.enableNonStreamingFallback = partial.enableNonStreamingFallback;
  }
}
