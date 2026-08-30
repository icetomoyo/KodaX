/**
 * KodaX Provider Registry
 *
  * Provider 注册表 - 统一管理所有 Provider
 */

import { KodaXBaseProvider } from './base.js';
import {
  createAnthropicSdkClient,
  KodaXAnthropicCompatProvider,
} from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import { KodaXGeminiCliProvider } from './gemini-cli.js';
import { KodaXCodexCliProvider } from './codex-cli.js';
import {
  KodaXModelDescriptor,
  KodaXOpenAICompatMaxOutputTokensField,
  KodaXProviderCapabilityProfile,
  KodaXProviderConfig,
  KodaXReasoningCapability,
  KodaXReasoningProfile,
  KodaXVerifyStrategy,
} from '../types.js';
import { KodaXProviderError } from '../errors.js';
import {
  hasProviderCredentialContext,
  hasScopedProviderCredentialAuthority,
  resolveProviderCredential,
} from '../provider-credential-context.js';
import {
  cloneCapabilityProfile,
  normalizeCapabilityProfile,
} from './capability-profile.js';
import { getProviderSnapshots } from './provider-capabilities.loader.js';
import type Anthropic from '@anthropic-ai/sdk';

// ============== Provider 名称类型 ==============

export type ProviderName =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'kimi'
  | 'kimi-code'
  | 'qwen'
  | 'qwen-token-plan'
  | 'zhipu'
  | 'zhipu-coding'
  | 'zai-coding'
  | 'minimax-coding'
  | 'mimo-coding'
  | 'mimo'
  | 'ark-coding'
  | 'gemini-cli'
  | 'codex-cli';

/**
 * Per-provider static metadata. v0.7.43 promoted this from a partial
 * descriptor (`models: string[]`) to the full capability surface so
 * SDK consumers can read context windows / max output tokens /
 * thinking-budget caps / per-model descriptors without instantiating
 * a Provider class (which previously required a valid API key just
 * to read static metadata).
 *
 * v0.7.44 FEATURE_198 moved the data into a separate JSON file
 * (`provider-capabilities.json`) so it can be patched without a
 * KodaX release. The structural type below mirrors the JSON-resolved
 * shape and remains the single source of truth for capability data;
 * Provider classes derive their runtime `config` from it via
 * `buildProviderConfig`.
 */
type ProviderSnapshot = {
  readonly model: string;
  /**
   * Alternative model descriptors beyond the default `model`. Carries
   * per-model capability overrides (`contextWindow` / `maxOutputTokens` /
   * `thinkingBudgetCap` / `reasoningCapability` / `replayReasoningContent` /
   * `strictThinkingSignature`). Provider-level defaults below fill any
   * gaps a descriptor leaves unset. The default model has no descriptor
   * entry — it inherits provider-level defaults directly.
   */
  readonly models?: readonly KodaXModelDescriptor[];
  readonly apiKeyEnv: string;
  readonly reasoningCapability: KodaXReasoningCapability;
  readonly reasoningProfile?: KodaXReasoningProfile;
  readonly modelReasoningCapabilities?: Readonly<
    Record<string, KodaXReasoningCapability>
  >;
  readonly capabilityProfile: KodaXProviderCapabilityProfile;
  /** Maximum input context window (tokens). Provider-level default. */
  readonly contextWindow?: number;
  /** Per-turn output token cap KodaX requests. Provider-level default. */
  readonly maxOutputTokens?: number;
  /** OpenAI Chat Completions field used for the output-token cap. */
  readonly maxOutputTokensField?: KodaXOpenAICompatMaxOutputTokensField;
  /** Upper bound on `thinking_budget` for native-budget reasoning providers. */
  readonly thinkingBudgetCap?: number;
  /** Whether the provider supports `thinking_budget` / native reasoning. */
  readonly supportsThinking?: boolean;
  /**
   * FEATURE_216 v0.7.45 — Which verify primitive this provider supports
   * for credential checks. Mirrors `provider-capabilities.types.ts`
   * ProviderSnapshot's required field.
   */
  readonly verifyStrategy: KodaXVerifyStrategy;
};

// Canonical source for provider identity (apiKeyEnv, default model,
// reasoning capability, capability profile). Per-class Provider configs
// derive the three overlapping fields via `buildProviderConfig` so the
// two structures cannot drift.
//
// v0.7.44 FEATURE_198: backed by `provider-capabilities.json` via the
// loader; the JSON is read once at module init, validated, and resolved
// (profile-name strings → KodaXProviderCapabilityProfile objects;
// cliBridge entries filled with local CLI's default/known models). The
// export surface is unchanged — every consumer that read this Record
// continues to read the same Record shape, no caller-side changes.
export const KODAX_PROVIDER_SNAPSHOTS: Record<ProviderName, ProviderSnapshot> =
  // Loader returns Readonly<Record<string, ProviderSnapshot>>; the boot
  // validator ensures every ProviderName key is populated, so the
  // narrowed cast is safe. Double-cast (via unknown) silences the TS
  // overlap warning that FEATURE_216's stricter ProviderSnapshot
  // (mandatory verifyStrategy) surfaces.
  getProviderSnapshots() as unknown as Record<ProviderName, ProviderSnapshot>;

// Derive a Provider class's config from the canonical snapshot plus the
// per-class overrides (runtime-only fields: baseUrl, streamMaxDurationMs,
// replayReasoningContent, strictThinkingSignature, etc.). All capability
// fields (`apiKeyEnv` / `model` / `reasoningCapability` / `models` /
// `contextWindow` / `maxOutputTokens` / `thinkingBudgetCap` /
// `supportsThinking` / `reasoningProfile`) are sourced exclusively from the snapshot so the
// snapshot stays the single source of truth — Provider classes only
// supply runtime knobs.
type ProviderRuntimeExtras = Omit<
  KodaXProviderConfig,
  | 'apiKeyEnv'
  | 'model'
  | 'reasoningCapability'
  | 'reasoningProfile'
  | 'models'
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'maxOutputTokensField'
  | 'thinkingBudgetCap'
  | 'supportsThinking'
  | 'verifyStrategy'
> & { supportsThinking?: boolean };

function buildProviderConfig<K extends ProviderName>(
  name: K,
  extras: ProviderRuntimeExtras = {},
): KodaXProviderConfig {
  const snapshot = KODAX_PROVIDER_SNAPSHOTS[name];
  return {
    apiKeyEnv: snapshot.apiKeyEnv,
    model: snapshot.model,
    reasoningCapability: snapshot.reasoningCapability,
    reasoningProfile: snapshot.reasoningProfile,
    models: snapshot.models,
    contextWindow: snapshot.contextWindow,
    maxOutputTokens: snapshot.maxOutputTokens,
    maxOutputTokensField: snapshot.maxOutputTokensField,
    thinkingBudgetCap: snapshot.thinkingBudgetCap,
    supportsThinking: snapshot.supportsThinking ?? false,
    verifyStrategy: snapshot.verifyStrategy,
    ...extras,
  };
}

// ============== 具体 Provider 实现 ==============

class AnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'anthropic';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('anthropic', {
    // Anthropic proper cryptographically verifies `signature` on
    // `thinking` blocks. Cross-provider thinking (kept around when
    // user /model-switches mid-session) carries empty or other-issuer
    // signatures that fail verification → 400. The serialiser converts
    // those to a `<prior_reasoning>` text block; only Anthropic-issued
    // thinking blocks pass through. Third-party Anthropic-compat
    // providers (kimi-code, ark-coding, etc.) lack the signing key and
    // accept any signature, so they keep the lenient default. v0.7.28.
    strictThinkingSignature: true,
  });

  // Anthropic proper talks to api.anthropic.com and must keep the SDK's
  // native user agent — unlike the compat base, it adds no gateway headers.
  protected override buildClient(): Promise<Anthropic> {
    return createAnthropicSdkClient({ apiKey: this.getApiKey() });
  }
}

class ZhipuCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'zhipu-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('zhipu-coding', {
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    // streamMaxDurationMs 300s: GLM's 308s server-side kill window includes
    // server-side jitter; client-side timer measured from request send sees
    // server kill at ~308.5s (after RTT). 300s gives a ~8s pre-emption
    // margin so the watchdog aborts BEFORE the server RSTs, routing through
    // non_streaming_fallback cleanly. Other anthropic-compat coding-plan
    // providers (kimi-code, mimo-coding, minimax-coding) completed 64K
    // cleanly in bench and need no equivalent cap.
    streamMaxDurationMs: 300_000,
  });
}

class ZaiCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'zai-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('zai-coding', {
    // Zhipu Coding Plan overseas mirror (api.z.ai). Same upstream models
    // and capability surface as zhipu-coding — the two providers differ
    // only in baseUrl and the API-key env var. Inherits the 300s
    // streamMaxDurationMs cap for the same GLM server-side kill-window
    // reason documented above (the overseas gateway proxies to the same
    // backend, so the timing characteristic applies identically).
    baseUrl: 'https://api.z.ai/api/anthropic',
    streamMaxDurationMs: 300_000,
  });
}

class KimiCodeProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'kimi-code';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('kimi-code', {
    // The subscription endpoint now routes three explicit model ids:
    // K3 plus K2.7 Code Standard / HighSpeed. Keep the Anthropic-compatible
    // path for native tool_use and preserved-thinking history fidelity.
    baseUrl: 'https://api.kimi.com/coding/',
    promptCacheAffinity: true,
  });
}

class MiniMaxCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'minimax-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('minimax-coding', {
    baseUrl: 'https://api.minimaxi.com/anthropic',
  });
}

class MimoCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'mimo-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('mimo-coding', {
    // CN cluster (Token Plan also has SGP / AMS clusters at
    // token-plan-{sgp,ams}.xiaomimimo.com/anthropic — same protocol,
    // pin to CN until users surface a region-switch need).
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
  });
}

class MimoProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'mimo';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('mimo', {
    // Xiaomi MiMo public pay-per-token Anthropic-compat endpoint
    // (https://platform.xiaomimimo.com/docs/zh-CN/api/chat/anthropic-api).
    // Same upstream model family as `mimo-coding` (mimo-v2.5-pro /
    // mimo-v2.5) — the two providers differ only in baseUrl and the
    // billing model (pay-per-token here vs Token-Plan subscription on
    // mimo-coding). All capability fields (context window, thinking
    // budget, max_tokens, etc.) come from `provider-capabilities.json`.
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
  });
}

class ArkCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'ark-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('ark-coding', {
    // Volcengine Ark Coding Plan, Beijing cluster. The overseas BytePlus
    // mirror at https://ark.ap-southeast.bytepluses.com/api/coding speaks
    // the same protocol; users outside CN can override via baseUrl env or
    // a custom provider entry.
    //
    // ⚠️  Use ONLY the `/api/coding` path. The sibling `/api/v3` (without
    // `coding/`) is the standard pay-per-token Ark API and does NOT consume
    // Coding Plan quota — accidentally pointing here bills outside the
    // subscription.
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
  });
}

class OpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name = 'openai';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('openai', {
    promptCacheAffinity: true,
  });
}

class DeepSeekProvider extends KodaXOpenAICompatProvider {
  readonly name = 'deepseek';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('deepseek', {
    baseUrl: 'https://api.deepseek.com',
    // V4 thinking mode 400s on multi-turn replays that strip
    // reasoning_content (empirically verified via direct API probe).
    // Kimi/Qwen/Zhipu share the same OpenAI-compat field convention so
    // they get the same flag for max fault-tolerance — see those
    // provider entries below.
    replayReasoningContent: true,
  });
}

class KimiProvider extends KodaXOpenAICompatProvider {
  readonly name = 'kimi';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('kimi', {
    baseUrl: 'https://api.moonshot.cn/v1',
    promptCacheAffinity: true,
    // Same OpenAI-compat reasoning_content convention as DeepSeek V4.
    // Verified against K2.7 Code multi-turn tool use on 2026-07-16:
    // preserved thinking requires reasoning_content to remain in history.
    // OpenAI proper stays explicitly off (different protocol).
    replayReasoningContent: true,
  });
}

class QwenProvider extends KodaXOpenAICompatProvider {
  readonly name = 'qwen';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('qwen', {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // Same rationale as Kimi above — unverified, opting in.
    replayReasoningContent: true,
  });
}

class QwenTokenPlanProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'qwen-token-plan';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('qwen-token-plan', {
    // Live comparison on 2026-07-20 confirmed parity with the OpenAI endpoint
    // for streaming thinking + tool use across Qwen / GLM / DeepSeek. Prefer
    // Anthropic-compatible blocks here to reuse explicit cache boundaries and
    // the production-proven coding-plan path.
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
  });
}

class ZhipuProvider extends KodaXOpenAICompatProvider {
  readonly name = 'zhipu';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('zhipu', {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    // Same rationale as Kimi above — unverified, opting in.
    replayReasoningContent: true,
  });
}

// ============== Provider 工厂 ==============

export const KODAX_PROVIDERS: Record<string, () => KodaXBaseProvider> = {
  anthropic: () => new AnthropicProvider(),
  openai: () => new OpenAIProvider(),
  deepseek: () => new DeepSeekProvider(),
  kimi: () => new KimiProvider(),
  'kimi-code': () => new KimiCodeProvider(),
  qwen: () => new QwenProvider(),
  'qwen-token-plan': () => new QwenTokenPlanProvider(),
  zhipu: () => new ZhipuProvider(),
  'zhipu-coding': () => new ZhipuCodingProvider(),
  'zai-coding': () => new ZaiCodingProvider(),
  'minimax-coding': () => new MiniMaxCodingProvider(),
  'mimo-coding': () => new MimoCodingProvider(),
  mimo: () => new MimoProvider(),
  'ark-coding': () => new ArkCodingProvider(),
  'gemini-cli': () => new KodaXGeminiCliProvider(),
  'codex-cli': () => new KodaXCodexCliProvider(),
};

export const KODAX_DEFAULT_PROVIDER = process.env.KODAX_PROVIDER ?? 'zhipu-coding';

// Lazy singleton cache for built-in provider instances. Keyed on both the
// provider name and the current apiKey env value so tests that mutate
// `*_API_KEY` between cases still see a fresh SDK client (Issue: repeated
// `new Anthropic({...})` is expensive and held onto process state — the
// cache means each provider class wires its SDK client exactly once per
// credential configuration, and shared across call sites).
interface BuiltinProviderCacheEntry {
  apiKey: string | undefined;
  instance: KodaXBaseProvider;
}
const builtinProviderCache = new Map<string, BuiltinProviderCacheEntry>();

function resolveApiKeyEnvForProvider(name: string): string | undefined {
  if (!isProviderName(name)) {
    return undefined;
  }
  return KODAX_PROVIDER_SNAPSHOTS[name].apiKeyEnv;
}

export function getProvider(name?: string): KodaXBaseProvider {
  const n = name ?? KODAX_DEFAULT_PROVIDER;
  const factory = KODAX_PROVIDERS[n];
  if (!factory) {
    throw new KodaXProviderError(
      `Unknown provider: ${n}. Available: ${Object.keys(KODAX_PROVIDERS).join(', ')}`,
      n,
      { failureCode: 'provider_not_registered', stage: 'catalog' },
    );
  }

  if (hasProviderCredentialContext()) return factory();

  const apiKeyEnv = resolveApiKeyEnvForProvider(n);
  const currentApiKey = resolveProviderCredential(
    n,
    apiKeyEnv ? process.env[apiKeyEnv] : undefined,
  );

  const cached = builtinProviderCache.get(n);
  if (cached && cached.apiKey === currentApiKey) {
    return cached.instance;
  }

  const instance = factory();
  builtinProviderCache.set(n, { apiKey: currentApiKey, instance });
  return instance;
}

/**
 * Drop all cached built-in provider instances. Intended for tests that
 * manipulate `*_API_KEY` env variables outside the normal lifecycle
 * (the cache already self-invalidates on env changes, but callers may
 * want an explicit reset for isolation).
 */
export function resetBuiltinProviderCache(): void {
  builtinProviderCache.clear();
}

// 检查 Provider 是否已配置 API Key
export function isProviderConfigured(name: string): boolean {
  if (!isProviderName(name)) {
    return false;
  }
  const scopedAuthority = hasScopedProviderCredentialAuthority(name);
  if (scopedAuthority !== undefined) return scopedAuthority;
  return resolveProviderCredential(
    name,
    process.env[KODAX_PROVIDER_SNAPSHOTS[name].apiKeyEnv],
  ) !== undefined;
}

// 获取 Provider 使用的模型名称
export function getProviderModel(name: string): string | null {
  return isProviderName(name)
    ? KODAX_PROVIDER_SNAPSHOTS[name].model
    : null;
}

export function getProviderConfiguredReasoningCapability(
  name: string,
  modelOverride?: string,
): KodaXReasoningCapability | 'unknown' {
  if (!isProviderName(name)) {
    return 'unknown';
  }

  const snapshot = KODAX_PROVIDER_SNAPSHOTS[name];
  const effectiveModel = modelOverride ?? snapshot.model;
  const descriptor = snapshot.models?.find((m) => m.id === effectiveModel);

  return descriptor?.reasoningCapability
    ?? snapshot.modelReasoningCapabilities?.[effectiveModel]
    ?? snapshot.reasoningCapability;
}

export function getProviderConfiguredCapabilityProfile(
  name: string,
): KodaXProviderCapabilityProfile | null {
  return isProviderName(name)
    ? cloneCapabilityProfile(KODAX_PROVIDER_SNAPSHOTS[name].capabilityProfile)
    : null;
}

// 获取所有可用的 Provider 列表（带配置状态）
export function getProviderList(): Array<{
  name: string;
  model: string;
  models: string[];
  configured: boolean;
  reasoningCapability: KodaXReasoningCapability;
  reasoningProfile?: KodaXReasoningProfile;
  capabilityProfile: KodaXProviderCapabilityProfile;
}> {
  const result: Array<{
    name: string;
    model: string;
    models: string[];
    configured: boolean;
    reasoningCapability: KodaXReasoningCapability;
    reasoningProfile?: KodaXReasoningProfile;
    capabilityProfile: KodaXProviderCapabilityProfile;
  }> = [];
  for (const name of Object.keys(KODAX_PROVIDERS) as ProviderName[]) {
    const snapshot = KODAX_PROVIDER_SNAPSHOTS[name];
    result.push({
      name,
      model: snapshot.model,
      models: getProviderModels(name),
      configured: !!process.env[snapshot.apiKeyEnv],
      reasoningCapability: snapshot.reasoningCapability,
      reasoningProfile: snapshot.reasoningProfile,
      capabilityProfile: cloneCapabilityProfile(snapshot.capabilityProfile),
    });
  }
  return result;
}

// 获取内置 Provider 的可用模型列表（不需要实例化 Provider，不依赖 API Key）
export function getProviderModels(name: string): string[] {
  return getProviderModelDescriptors(name).map((model) => model.id);
}

// 类型守卫函数：检查字符串是否为有效的 Provider 名称
export function isProviderName(name: string): name is ProviderName {
  return name in KODAX_PROVIDERS;
}

// ============== SDK Model Capability Exposure (v0.7.43) ==============
//
// These getters read directly from `KODAX_PROVIDER_SNAPSHOTS` (the single
// source of truth post-refactor) so SDK consumers can list provider /
// model capabilities WITHOUT a Provider instance — meaning without
// requiring the API key env var to be set. KodaX itself maintains this
// metadata; consumers only need to know the provider name.
//
// Custom-provider counterparts live in `custom-registry.ts` and dispatch
// from `resolveProviderModelDescriptors` / `resolveModelCapabilities`
// below (which route built-in vs custom-name lookups transparently).

/**
 * Effective per-model capability surface. v0.7.43 SDK exposure.
 *
 * Values are resolved with the cascade:
 *   1. Per-model descriptor override (`KodaXModelDescriptor` field)
 *   2. Provider-level default (`KODAX_PROVIDER_SNAPSHOTS[name].*`)
 *   3. `undefined` (the field is genuinely not advertised for this model)
 *
 * `displayName` falls back to `id` when not set; never undefined.
 *
 * **All fields below are KodaX-maintained values** — they reflect what
 * KodaX itself uses at runtime (the per-turn `max_tokens` we request,
 * the thinking budget we cap at, etc.), benchmarked against the upstream
 * model so they are honest representations of the agent's behavior. They
 * are deliberately NOT sourced from upstream `/models` API responses,
 * which a 2026-05 cross-provider probe confirmed are sparse and often
 * empty (see public_docs/sdk/embedder-guide.md §9). Embedders showing these
 * values in a popout UI can trust them.
 */
export interface KodaXModelCapabilities {
  /** Provider name (`anthropic`, `kimi`, `ark-coding`, or any custom name). */
  provider: string;
  /** Model id (the value `runKodaX(... { model } ...)` accepts). */
  model: string;
  /** Human-readable label — falls back to `model` when no descriptor entry. */
  displayName: string;
  /** Whether the provider supports `thinking_budget` / native reasoning. */
  supportsThinking: boolean;
  /** Effective reasoning capability for THIS model (per-model override aware). */
  reasoningCapability: KodaXReasoningCapability;
  /** Effort-first reasoning capability metadata for THIS model, when known. */
  reasoningProfile?: KodaXReasoningProfile;
  /** Maximum input context window (tokens). `undefined` for CLI-bridge providers. */
  contextWindow?: number;
  /**
   * Per-turn `max_tokens` KodaX requests. KodaX-side decision —
   * benchmarked against each provider (kill-windows, decode rate, cost
   * predictability). NOT the upstream "theoretical maximum" — providers
   * often advertise inflated ceilings; this value reflects what KodaX
   * actually asks for. If you display "expected output size" in your UI,
   * use this. Long generations escalate through the L5 continuation
   * meta path, not by raising this number per-turn.
   */
  maxOutputTokens?: number;
  /** Upper bound on `thinking_budget` (native-budget providers only). */
  thinkingBudgetCap?: number;
  /** True when the model is the provider's default (the `model` field on the snapshot). */
  isDefault: boolean;
}

function makeDefaultDescriptor(
  snapshot: ProviderSnapshot,
): KodaXModelDescriptor {
  // The default model has no descriptor entry in `models[]` — synthesize
  // one from provider-level defaults so callers see a uniform shape.
  return { id: snapshot.model };
}

function resolveWireModelDescriptor(
  snapshot: ProviderSnapshot,
  descriptor: KodaXModelDescriptor,
): KodaXModelDescriptor {
  if (!descriptor.wireModel) return descriptor;
  const wireDescriptor = snapshot.models?.find((model) => model.id === descriptor.wireModel);
  return wireDescriptor ? { ...wireDescriptor, ...descriptor } : descriptor;
}

function effectiveCapabilities(
  providerName: string,
  snapshot: ProviderSnapshot,
  descriptor: KodaXModelDescriptor,
): KodaXModelCapabilities {
  const isDefault = descriptor.id === snapshot.model;
  return {
    provider: providerName,
    model: descriptor.id,
    displayName: descriptor.displayName ?? descriptor.id,
    supportsThinking: snapshot.supportsThinking ?? false,
    reasoningCapability:
      descriptor.reasoningCapability ?? snapshot.reasoningCapability,
    reasoningProfile:
      descriptor.reasoningProfile ?? snapshot.reasoningProfile,
    contextWindow: descriptor.contextWindow ?? snapshot.contextWindow,
    maxOutputTokens: descriptor.maxOutputTokens ?? snapshot.maxOutputTokens,
    thinkingBudgetCap:
      descriptor.thinkingBudgetCap ?? snapshot.thinkingBudgetCap,
    isDefault,
  };
}

/**
 * List all model descriptors for a built-in provider — default model first,
 * then alternatives. No API key required (reads from KODAX_PROVIDER_SNAPSHOTS).
 *
 * Returns an empty array for unknown provider names so SDK consumers can
 * iterate `[...KODAX_PROVIDER_LIST, ...customNames]` without a guard per name.
 */
export function getProviderModelDescriptors(
  name: string,
): KodaXModelDescriptor[] {
  const snapshot = KODAX_PROVIDER_SNAPSHOTS[name as ProviderName];
  if (!snapshot) return [];
  // Default first, then alternatives. When the default model ALSO has an entry
  // in models[] (e.g. zhipu-coding defaults to glm-5.3, while zai-coding and
  // ark-coding default to glm-5.2; each has a 1M-window override), use that entry as the default
  // descriptor and drop it from the alternatives — otherwise the default is
  // listed TWICE (once as a bare descriptor, once with its override) and a picker
  // UI shows a duplicate row with inconsistent metadata. Matches the custom-
  // provider descriptor path, which already dedupes.
  const models = snapshot.models ?? [];
  const defaultEntry = models.find((m) => m.id === snapshot.model);
  const alternatives = models.filter((m) => m.id !== snapshot.model);
  return [defaultEntry ?? makeDefaultDescriptor(snapshot), ...alternatives]
    .map((descriptor) => resolveWireModelDescriptor(snapshot, descriptor));
}

/**
 * Effective per-model capability surface for a built-in provider.
 *
 * Returns `undefined` only for an unknown PROVIDER name. An unknown MODEL under
 * a known provider inherits the provider-level capability (optimistic-wide
 * default — see the inline note below), so callers always get a usable surface
 * for any model id routed to a known provider.
 *
 * No API key required.
 */
export function getModelCapabilities(
  providerName: string,
  modelId: string,
): KodaXModelCapabilities | undefined {
  const snapshot = KODAX_PROVIDER_SNAPSHOTS[providerName as ProviderName];
  if (!snapshot) return undefined;
  // Prefer an explicit models[] entry FIRST, even when modelId is the provider's
  // default model: a provider's default can declare its own per-model overrides
  // (e.g. zhipu-coding defaults to glm-5.3, while zai-coding and ark-coding
  // default to glm-5.2; each carries a 1M context + 128-131K output override). Selecting the bare default descriptor
  // ahead of that entry silently dropped those overrides — the "context window
  // shows 200K" bug. This mirrors base.ts getModelDescriptor precedence so
  // resolveModelCapabilities agrees with getEffectiveContextWindow/MaxOutputTokens.
  const entry = snapshot.models?.find((m) => m.id === modelId);
  if (entry) {
    return effectiveCapabilities(
      providerName,
      snapshot,
      resolveWireModelDescriptor(snapshot, entry),
    );
  }
  if (modelId === snapshot.model) {
    return effectiveCapabilities(providerName, snapshot, makeDefaultDescriptor(snapshot));
  }
  // Unknown model under a KNOWN built-in provider: inherit the provider-level
  // capability (reasoning strategy is overwhelmingly a provider/family trait,
  // not per-model), tagged to the requested model id. This optimistic-wide
  // default keeps every effort rung the family advertises reachable, so a
  // freshly-released model id (e.g. a new GLM revision) still gets the right
  // ladder instead of collapsing to the generic off/low/medium/high fallback.
  // If a specific effort turns out unsupported, the real-response narrowing
  // path corrects it. Returns a non-default descriptor so `isDefault` is false.
  return effectiveCapabilities(providerName, snapshot, { id: modelId });
}

/**
 * Full capability listing for every built-in provider/model pair. Default
 * model comes first per provider, in the order providers appear in
 * `KODAX_PROVIDERS`. Use this for popout UIs that enumerate all models
 * without filtering by `configured` (the consumer can filter post-hoc by
 * checking `process.env[snapshot.apiKeyEnv]` themselves, or just present
 * everything for selection).
 *
 * Custom-provider models are exposed via the equivalent helper in
 * `custom-registry.ts` (`getCustomProviderModelCapabilities`).
 */
export function listBuiltinModelCapabilities(): KodaXModelCapabilities[] {
  const result: KodaXModelCapabilities[] = [];
  for (const name of Object.keys(KODAX_PROVIDERS) as ProviderName[]) {
    const snapshot = KODAX_PROVIDER_SNAPSHOTS[name];
    for (const descriptor of getProviderModelDescriptors(name)) {
      result.push(effectiveCapabilities(name, snapshot, descriptor));
    }
  }
  return result;
}

export { normalizeCapabilityProfile };
