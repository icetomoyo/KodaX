/**
 * Unified Provider Resolver
 *
 * Resolves provider instances by checking built-in registry first,
 * then custom providers. Built-in takes precedence on name collision.
 */

import type {
  KodaXListModelsResult,
  KodaXModelDescriptor,
  KodaXVerifyCredentialResult,
  KodaXVerifyStrategy,
} from '../types.js';
import { KodaXProviderError } from '../errors.js';
import type { KodaXBaseProvider } from './base.js';
import {
  KODAX_PROVIDERS,
  KODAX_PROVIDER_SNAPSHOTS,
  isProviderName,
  type KodaXModelCapabilities,
  getProviderModelDescriptors,
  getModelCapabilities,
  listBuiltinModelCapabilities,
} from './registry.js';
import {
  getCustomProvider,
  isCustomProviderName,
  getCustomProviderNames,
  getCustomProviderModelDescriptors,
  getCustomModelCapabilities,
  listCustomProviderModelCapabilities,
  getCustomProviderVerifyMetadata,
} from './custom-registry.js';
import {
  getRuntimeModelProvider,
  getRuntimeModelProviderCredentialEnvironmentNames,
  getRuntimeModelProviderNames,
  isRuntimeModelProviderName,
} from './runtime-registry.js';

/**
 * Resolve a provider by name. Built-in providers take precedence over custom.
 * @throws Error if provider is not found in either registry.
 */
export function resolveProvider(name: string): KodaXBaseProvider {
  // Built-in first
  if (isProviderName(name)) {
    return KODAX_PROVIDERS[name]();
  }
  // Runtime-registered model providers next
  const runtimeProvider = getRuntimeModelProvider(name);
  if (runtimeProvider) {
    return runtimeProvider;
  }
  // Custom second
  const custom = getCustomProvider(name);
  if (custom) {
    return custom;
  }
  const available = getAvailableProviderNames();
  throw new KodaXProviderError(
    `Unknown provider: ${name}. Available: ${available.join(', ')}`,
    name,
    { failureCode: 'provider_not_registered', stage: 'catalog' },
  );
}

/**
 * Check if a name refers to any known provider (built-in or custom).
 */
export function isKnownProvider(name: string): boolean {
  return isProviderName(name) || isRuntimeModelProviderName(name) || isCustomProviderName(name);
}

/**
 * Get all available provider names (built-in + custom).
 */
export function getAvailableProviderNames(): string[] {
  const builtIn = Object.keys(KODAX_PROVIDERS);
  const runtimeNames = getRuntimeModelProviderNames();
  const customNames = getCustomProviderNames();
  // Deduplicate (built-in takes precedence)
  return [...new Set([...builtIn, ...runtimeNames, ...customNames])];
}

/**
 * Exact environment-variable names that may carry credentials for any
 * registered Provider. Shell execution uses the complete set so switching the
 * active Provider cannot make an inactive Provider's credential visible.
 *
 * Runtime Provider factories are evaluated because their public registration
 * contract does not otherwise expose credential metadata. A failing factory is
 * intentionally fail-closed for configured shell execution.
 */
export function getProviderCredentialEnvironmentNames(): string[] {
  const names = new Set<string>();
  for (const snapshot of Object.values(KODAX_PROVIDER_SNAPSHOTS)) {
    names.add(snapshot.apiKeyEnv);
  }
  for (const name of getCustomProviderNames()) {
    const metadata = getCustomProviderVerifyMetadata(name);
    if (metadata !== undefined) names.add(metadata.apiKeyEnv);
  }
  for (const name of getRuntimeModelProviderCredentialEnvironmentNames()) {
    names.add(name);
  }
  return [...names].sort();
}

// ============== SDK Model Capability Dispatchers (v0.7.43) ==============
//
// Unified entry points routing built-in vs custom-provider lookups
// transparently. SDK consumers (KodaX Space etc.) call these — they
// don't need to know whether a provider is built-in or registered
// from `~/.kodax/config.json`. No API key required for either path.

/**
 * Model descriptors for any registered provider (built-in or custom).
 * Default model first, then alternatives. Empty array if name unknown.
 */
export function resolveProviderModelDescriptors(
  name: string,
): KodaXModelDescriptor[] {
  if (isProviderName(name)) {
    return getProviderModelDescriptors(name);
  }
  return getCustomProviderModelDescriptors(name) ?? [];
}

/**
 * Effective capabilities for a single provider/model pair. Built-in
 * lookup first, then custom. Returns undefined when neither has it.
 */
export function resolveModelCapabilities(
  providerName: string,
  modelId: string,
): KodaXModelCapabilities | undefined {
  if (isProviderName(providerName)) {
    return getModelCapabilities(providerName, modelId);
  }
  return getCustomModelCapabilities(providerName, modelId);
}

/**
 * Every model capability KodaX knows about — built-in + custom — in
 * a single flat list. Built-in providers come first (in `KODAX_PROVIDERS`
 * declaration order), then custom providers (in registration order).
 * Within each provider, default model first.
 *
 * Use for popout UIs that need a single source for a model picker.
 * No filtering by `configured` — consumers can subset themselves by
 * checking `process.env[snapshot.apiKeyEnv]` if they care.
 */
export function listAllModelCapabilities(): KodaXModelCapabilities[] {
  return [
    ...listBuiltinModelCapabilities(),
    ...listCustomProviderModelCapabilities(),
  ];
}

// ============== FEATURE_216 v0.7.45 — Credential Verification ==============

interface ProviderVerifyMetadata {
  readonly apiKeyEnv: string;
  readonly verifyStrategy: KodaXVerifyStrategy;
}

/**
 * Look up the (apiKeyEnv, verifyStrategy) pair for any registered
 * provider WITHOUT instantiating it. Returns undefined when the name is
 * unknown. This is the bypass path for `verifyProviderCredential` to
 * short-circuit on `unsupported` strategy or `unconfigured` env before
 * hitting the provider ctor (which throws on missing API key).
 */
function getProviderVerifyMetadata(
  name: string,
): ProviderVerifyMetadata | undefined {
  if (isProviderName(name)) {
    const s = KODAX_PROVIDER_SNAPSHOTS[name];
    return { apiKeyEnv: s.apiKeyEnv, verifyStrategy: s.verifyStrategy };
  }
  // Runtime-registered providers don't go through snapshot — they're
  // already instantiated, so caller has whatever key state they set.
  // Treat them like unknown for the metadata path; the orchestrator
  // can still try-instantiate them in the main path below.
  if (isRuntimeModelProviderName(name)) {
    return undefined;
  }
  return getCustomProviderVerifyMetadata(name);
}

/**
 * FEATURE_216 v0.7.45 — Top-level lightweight credential verification
 * for any registered provider (built-in / custom / runtime).
 *
 * Never throws. Short-circuits before hitting the provider ctor for:
 *   - unknown provider name → `unsupported`
 *   - cli-bridge / `verifyStrategy='unsupported'` → `unsupported`
 *   - env var missing → `unconfigured`  (avoids the `getApiKey()` throw)
 *
 * Otherwise instantiates via `resolveProvider(name)` and delegates to
 * `provider.verifyCredential(opts)`. Cost: 0 tokens (count-tokens /
 * models-list strategies) or ~6-7 tokens (minimal-message strategy).
 */
export async function verifyProviderCredential(
  name: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<KodaXVerifyCredentialResult> {
  const meta = getProviderVerifyMetadata(name);

  if (!meta && !isKnownProvider(name)) {
    return {
      ok: false,
      error: 'unsupported',
      strategy: 'unsupported',
      durationMs: 0,
      approxTokensSpent: 0,
      message: `Unknown provider: "${name}". Available: ${getAvailableProviderNames().join(', ')}`,
    };
  }

  if (meta?.verifyStrategy === 'unsupported') {
    return {
      ok: false,
      error: 'unsupported',
      strategy: 'unsupported',
      durationMs: 0,
      approxTokensSpent: 0,
      message: `Provider "${name}" does not support credential verification (cli-bridge or strategy marked unsupported)`,
    };
  }

  if (meta && !process.env[meta.apiKeyEnv]) {
    return {
      ok: false,
      error: 'unconfigured',
      strategy: meta.verifyStrategy,
      durationMs: 0,
      approxTokensSpent: 0,
      message: `Environment variable "${meta.apiKeyEnv}" is not set for provider "${name}"`,
    };
  }

  // Safe to instantiate now: known name + env set (or runtime-registered
  // where caller handled their own state). The ctor will throw if env is
  // missing on a runtime path — surface as unknown rather than crashing
  // the caller.
  let provider: KodaXBaseProvider;
  try {
    provider = resolveProvider(name);
  } catch (err) {
    return {
      ok: false,
      error: 'unconfigured',
      strategy: meta?.verifyStrategy ?? 'unsupported',
      durationMs: 0,
      approxTokensSpent: 0,
      message: String((err as Error)?.message ?? err).slice(0, 240),
    };
  }
  // Wrap the actual verify call too — preserves the never-throws
  // contract even for runtime-registered providers whose verifyCredential
  // override (third-party extensions predating FEATURE_216) might throw
  // instead of returning a result envelope.
  try {
    return await provider.verifyCredential(opts);
  } catch (err) {
    return {
      ok: false,
      error: 'unknown',
      strategy: meta?.verifyStrategy ?? 'unsupported',
      durationMs: 0,
      approxTokensSpent: 0,
      message: String((err as Error)?.message ?? err).slice(0, 240),
    };
  }
}

/**
 * FEATURE_216 v0.7.45 — Returns the static model list KodaX maintains
 * for a provider. Distinct from credential verification: this is for
 * model-picker UIs in SDK consumers. Sourced from
 * `provider-capabilities.json` for built-in providers + the custom
 * registry for user-configured ones. Always `source: 'static'` in
 * v0.7.45 — KodaX-curated list is the authoritative source per
 * FEATURE_198 ("KodaX self-maintained snapshot is the only reliable
 * source" — upstream `/v1/models` is noisy/inconsistent across
 * providers). Future versions may add an opt-in upstream refresh.
 */
export async function listProviderModels(
  name: string,
  _opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<KodaXListModelsResult> {
  if (!isKnownProvider(name)) {
    return {
      ok: false,
      source: 'failed',
      error: `Unknown provider: "${name}"`,
      durationMs: 0,
    };
  }
  const descriptors = resolveProviderModelDescriptors(name);
  if (descriptors.length === 0) {
    return {
      ok: false,
      source: 'failed',
      error: `Provider "${name}" has no static model list`,
      durationMs: 0,
    };
  }
  const models = descriptors.map((d) => d.id);
  return {
    ok: true,
    source: 'static',
    models,
    durationMs: 0,
  };
}

