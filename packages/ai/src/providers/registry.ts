/**
 * KodaX Provider Registry
 *
 * Provider 注册表 - 统一管理所有 Provider
 */

import { KodaXBaseProvider } from './base.js';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import { KodaXGeminiCliProvider } from './gemini-cli.js';
import { KodaXCodexCliProvider } from './codex-cli.js';
import {
  KodaXProviderCapabilityProfile,
  KodaXProviderConfig,
  KodaXReasoningCapability,
} from '../types.js';
import { KodaXProviderError } from '../errors.js';
import {
  KODAX_CAPPED_MAX_OUTPUT_TOKENS,
  KODAX_ESCALATED_MAX_OUTPUT_TOKENS,
} from '../constants.js';
import {
  CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  cloneCapabilityProfile,
  IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
  NATIVE_PROVIDER_CAPABILITY_PROFILE,
  normalizeCapabilityProfile,
} from './capability-profile.js';
import {
  getCodexCliDefaultModel,
  getCodexCliKnownModels,
  getGeminiCliDefaultModel,
  getGeminiCliKnownModels,
} from './cli-bridge-models.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const GEMINI_CLI_DEFAULT_MODEL = getGeminiCliDefaultModel();
const GEMINI_CLI_MODELS = getGeminiCliKnownModels();
const CODEX_CLI_DEFAULT_MODEL = getCodexCliDefaultModel();
const CODEX_CLI_MODELS = getCodexCliKnownModels();

// ============== Provider 名称类型 ==============

export type ProviderName =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'kimi'
  | 'kimi-code'
  | 'qwen'
  | 'zhipu'
  | 'zhipu-coding'
  | 'minimax-coding'
  | 'mimo-coding'
  | 'gemini-cli'
  | 'codex-cli';

type ProviderSnapshot = {
  model: string;
  models?: readonly string[];
  apiKeyEnv: string;
  reasoningCapability: KodaXReasoningCapability;
  modelReasoningCapabilities?: Partial<Record<string, KodaXReasoningCapability>>;
  capabilityProfile: KodaXProviderCapabilityProfile;
};

// Canonical source for provider identity (apiKeyEnv, default model,
// reasoning capability, capability profile). Per-class Provider configs
// derive the three overlapping fields via `buildProviderConfig` so the
// two structures cannot drift.
export const KODAX_PROVIDER_SNAPSHOTS: Record<ProviderName, ProviderSnapshot> = {
  anthropic: {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-6',
    models: ['claude-opus-4-6', 'claude-haiku-4-5'],
    reasoningCapability: 'native-budget',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  openai: {
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'gpt-5.3-codex',
    models: ['gpt-5.4', 'gpt-5.3-codex-spark'],
    reasoningCapability: 'native-effort',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  deepseek: {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    // DeepSeek V4 series (1M context, OpenAI-style `reasoning_effort`).
    // The pre-V4 aliases `deepseek-chat` / `deepseek-reasoner` are slated
    // for deprecation on 2026-07-24 and have been removed from KodaX —
    // existing configs pointing at them should switch to v4-flash.
    model: 'deepseek-v4-flash',
    models: ['deepseek-v4-pro'],
    reasoningCapability: 'native-effort',
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  kimi: {
    apiKeyEnv: 'KIMI_API_KEY',
    model: 'kimi-k2.6',
    models: ['k2.5'],
    reasoningCapability: 'native-effort',
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  'kimi-code': {
    apiKeyEnv: 'KIMI_API_KEY',
    // The Kimi-for-Coding endpoint ignores the request `model` field and
    // always routes to whichever K2.x GA model the platform has currently
    // promoted (K2.6 as of 2026-04). We surface a single stable label so
    // users aren't tempted to pick a specific version that the server will
    // silently ignore.
    model: 'kimi-for-coding',
    reasoningCapability: 'native-budget',
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  qwen: {
    apiKeyEnv: 'QWEN_API_KEY',
    model: 'qwen3.5-plus',
    reasoningCapability: 'native-budget',
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  zhipu: {
    apiKeyEnv: 'ZHIPU_API_KEY',
    model: 'glm-5',
    models: ['glm-5.1', 'glm-5-turbo'],
    reasoningCapability: 'native-budget',
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  'zhipu-coding': {
    apiKeyEnv: 'ZHIPU_API_KEY',
    model: 'glm-5',
    models: ['glm-5.1', 'glm-5-turbo'],
    reasoningCapability: 'native-budget',
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  'minimax-coding': {
    apiKeyEnv: 'MINIMAX_API_KEY',
    model: 'MiniMax-M2.7',
    models: [
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2',
    ],
    reasoningCapability: 'native-budget',
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  'mimo-coding': {
    // Xiaomi MiMo Token Plan subscription endpoint (Anthropic-compat).
    // Token Plan keys are `tp-xxxxx`; pay-as-you-go keys (`sk-xxxxx`) are
    // a separate product on a different host and are NOT cross-compatible.
    apiKeyEnv: 'MIMO_API_KEY',
    model: 'mimo-v2.5-pro',
    models: ['mimo-v2.5'],
    reasoningCapability: 'native-budget',
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  'gemini-cli': {
    apiKeyEnv: 'GEMINI_API_KEY',
    model: GEMINI_CLI_DEFAULT_MODEL,
    models: GEMINI_CLI_MODELS.filter((model) => model !== GEMINI_CLI_DEFAULT_MODEL),
    reasoningCapability: 'prompt-only',
    capabilityProfile: CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  },
  'codex-cli': {
    apiKeyEnv: 'OPENAI_API_KEY',
    model: CODEX_CLI_DEFAULT_MODEL,
    models: CODEX_CLI_MODELS.filter((model) => model !== CODEX_CLI_DEFAULT_MODEL),
    reasoningCapability: 'prompt-only',
    capabilityProfile: CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  },
};

// Derive a Provider class's config from the canonical snapshot plus the
// per-class overrides (model metadata, runtime budgets, baseUrl). The
// three overlapping fields (`apiKeyEnv`, `model`, `reasoningCapability`)
// are sourced exclusively from the snapshot to eliminate drift.
function buildProviderConfig<K extends ProviderName>(
  name: K,
  extras: Omit<KodaXProviderConfig, 'apiKeyEnv' | 'model' | 'reasoningCapability'>,
): KodaXProviderConfig {
  const snapshot = KODAX_PROVIDER_SNAPSHOTS[name];
  return {
    apiKeyEnv: snapshot.apiKeyEnv,
    model: snapshot.model,
    reasoningCapability: snapshot.reasoningCapability,
    ...extras,
  };
}

// ============== 具体 Provider 实现 ==============

class AnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'anthropic';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('anthropic', {
    models: [
      { id: 'claude-opus-4-6', displayName: 'Opus 4.6', thinkingBudgetCap: 28000 },
      { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5', thinkingBudgetCap: 10000 },
    ],
    supportsThinking: true,
    contextWindow: 200000,  // 200K tokens
    // Anthropic API: max_tokens = thinking + output combined budget.
    // With thinkingBudgetCap=28000, 32768 left only ~4768 for actual output.
    // 64000 ensures ~36000+ tokens for output even at maximum thinking.
    maxOutputTokens: 64000,
    thinkingBudgetCap: 28000,
  });
  constructor() { super(); this.client = new Anthropic({ apiKey: this.getApiKey() }); }
}

class ZhipuCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'zhipu-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('zhipu-coding', {
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    models: [
      { id: 'glm-5.1', displayName: 'GLM-5.1' },
      // GLM-5 Turbo on the coding endpoint is the same 128K-context budget
      // tier as on the public endpoint. FEATURE_098.
      { id: 'glm-5-turbo', displayName: 'GLM-5 Turbo', contextWindow: 128_000 },
    ],
    supportsThinking: true,
    contextWindow: 200000,
    // Bench-confirmed: GLM Coding Plan has a ~308s server-side kill window
    // (mean 308.4s ± 0.2s, 6/6 reproductions on 64K stream tasks). At
    // ~40-57 tok/s decode rate, even 16K tokens generation typically lands
    // within the window; tasks needing more output flow through the L5
    // continuation meta path. Non-stream path bypasses the kill window
    // entirely (verified at 16K, 607s clean).
    //
    // Strategy (the only RST-prone provider in the bench, 2026-04):
    //   - maxOutputTokens 16K: target completion within the 308s kill
    //     window for typical tool_use turns (vs prior 32K which crosses).
    //   - streamMaxDurationMs 300s: GLM's 308s window already includes
    //     server-side jitter; client-side timer measured from request
    //     send sees server kill at ~308.5s (after RTT). 300s gives a
    //     ~8s pre-emption margin so the watchdog aborts BEFORE the
    //     server RSTs, routing through non_streaming_fallback cleanly.
    //
    // Other anthropic-compat coding-plan providers (kimi-code, mimo-coding,
    // minimax-coding) completed 64K cleanly in bench and need neither cap.
    // Override with env `KODAX_MAX_OUTPUT_TOKENS` to bypass the cap.
    maxOutputTokens: 16_000,
    thinkingBudgetCap: 16000,
    streamMaxDurationMs: 300_000,
  });
  constructor() { super(); this.initClient(); }
}

class KimiCodeProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'kimi-code';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('kimi-code', {
    baseUrl: 'https://api.kimi.com/coding/',
    // api.kimi.com/coding/ is a unified subscription-routed coding endpoint:
    // the server ignores the request `model` field and always serves the
    // current K2.x GA model. Listing version-specific labels (K2.5 / K2.6)
    // here would be misleading — the only honest identifier is the routing
    // alias `kimi-for-coding`, exposed via the snapshot's default model.
    // K2 server-side prefix caching is automatic on this endpoint, so
    // switching to the OpenAI-compat sibling (api.kimi.com/coding/v1) would
    // yield no cache benefit while losing tool_use schema fidelity.
    supportsThinking: true,
    contextWindow: 256000,
    // Bench-confirmed (2026-04): kimi-for-coding completes 64K stream
    // cleanly at 525s with stop_reason=tool_use (23K output tokens, 1400
    // HTML lines). Does NOT share the zhipu-coding 308s server-side kill
    // window. Capped at 32K for cost predictability; tasks needing more
    // output flow through the L5 continuation meta path. Override with
    // `KODAX_MAX_OUTPUT_TOKENS` to allow larger single-turn generation.
    maxOutputTokens: KODAX_CAPPED_MAX_OUTPUT_TOKENS,
  });
  constructor() { super(); this.initClient(); }
}

class MiniMaxCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'minimax-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('minimax-coding', {
    baseUrl: 'https://api.minimaxi.com/anthropic',
    // Probe (2026-04) against the public Token Plan: bare model IDs
    // (no `-highspeed` suffix) resolve, the `-highspeed` variants
    // return 500 "your current token plan not support model". Listing
    // the bare IDs as the canonical surface; legacy `-highspeed`
    // entries kept for users who do have them on a higher tier.
    models: [
      { id: 'MiniMax-M2.7', displayName: 'MiniMax M2.7' },
      { id: 'MiniMax-M2.7-highspeed', displayName: 'MiniMax M2.7 Highspeed (higher-tier plan)' },
      { id: 'MiniMax-M2.5', displayName: 'MiniMax M2.5' },
      { id: 'MiniMax-M2.5-highspeed', displayName: 'MiniMax M2.5 Highspeed (higher-tier plan)' },
      { id: 'MiniMax-M2.1', displayName: 'MiniMax M2.1' },
      { id: 'MiniMax-M2.1-highspeed', displayName: 'MiniMax M2.1 Highspeed (higher-tier plan)' },
      { id: 'MiniMax-M2', displayName: 'MiniMax M2' },
    ],
    supportsThinking: true,
    contextWindow: 204800,
    // Bench-confirmed (2026-04, MiniMax-M2.7 64K stream): completes
    // cleanly at 464.9s with stop_reason=tool_use (22.7K output tokens,
    // 2207 HTML lines). Does NOT share the zhipu-coding 308s kill
    // window. An earlier 304s zero-token observation against M2.5 was
    // model-specific (token plan capacity behavior on that variant),
    // not provider-wide. Standard cap (32K) + L5 continuation handles
    // long generation. Override with `KODAX_MAX_OUTPUT_TOKENS`.
    maxOutputTokens: KODAX_CAPPED_MAX_OUTPUT_TOKENS,
  });
  constructor() { super(); this.initClient(); }
}

class MimoCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'mimo-coding';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('mimo-coding', {
    // CN cluster (Token Plan also has SGP / AMS clusters at
    // token-plan-{sgp,ams}.xiaomimimo.com/anthropic — same protocol,
    // pin to CN until users surface a region-switch need).
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    models: [
      { id: 'mimo-v2.5', displayName: 'MiMo V2.5' },
    ],
    supportsThinking: true,
    // V2.5 series advertises a 1M context window (per platform docs).
    contextWindow: 1_000_000,
    // Bench-confirmed (2026-04): mimo-v2.5-pro completes 64K stream cleanly
    // at 309.6s with stop_reason=tool_use (24K output tokens, 1645 HTML
    // lines). Does NOT share the zhipu-coding 308s server-side kill window.
    // Capped at 32K for cost predictability; tasks needing more output
    // flow through the L5 continuation meta path. Override with
    // `KODAX_MAX_OUTPUT_TOKENS` to allow larger single-turn generation.
    maxOutputTokens: KODAX_CAPPED_MAX_OUTPUT_TOKENS,
    thinkingBudgetCap: 16_000,
  });
  constructor() { super(); this.initClient(); }
}

class OpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name = 'openai';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('openai', {
    models: [
      { id: 'gpt-5.4', displayName: 'GPT-5.4' },
      { id: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3 Codex Spark' },
    ],
    supportsThinking: true,
    contextWindow: 400000,
    maxOutputTokens: 32768,
  });
  constructor() { super(); this.initClient(); }
}

class DeepSeekProvider extends KodaXOpenAICompatProvider {
  readonly name = 'deepseek';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('deepseek', {
    baseUrl: 'https://api.deepseek.com',
    models: [
      { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
    ],
    supportsThinking: true,
    // V4 series ships a 1M context. Server advertises a 384K max output
    // ceiling but we cap per-turn output at the standard escalation budget
    // so streams finish well under server-side timeouts; the agent loop
    // already escalates on `stop_reason: max_tokens`.
    contextWindow: 1_000_000,
    maxOutputTokens: KODAX_ESCALATED_MAX_OUTPUT_TOKENS,
    // V4 thinking mode 400s on multi-turn replays that strip
    // reasoning_content. Qwen/Zhipu/Kimi/MiniMax use the same field but
    // remain unset until each is verified individually.
    replayReasoningContent: true,
  });
  constructor() { super(); this.initClient(); }
}

class KimiProvider extends KodaXOpenAICompatProvider {
  readonly name = 'kimi';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('kimi', {
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      // K2.5 only ships a 128K context; K2.6 (provider default) is 256K.
      // FEATURE_098: pin the real per-model window so compaction triggers
      // correctly when the user switches to k2.5.
      { id: 'k2.5', displayName: 'K2.5', contextWindow: 128_000 },
    ],
    supportsThinking: true,
    contextWindow: 256000,
    maxOutputTokens: 32768,
  });
  constructor() { super(); this.initClient(); }
}

class QwenProvider extends KodaXOpenAICompatProvider {
  readonly name = 'qwen';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('qwen', {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    supportsThinking: true,
    contextWindow: 256000,
    maxOutputTokens: 32768,
  });
  constructor() { super(); this.initClient(); }
}

class ZhipuProvider extends KodaXOpenAICompatProvider {
  readonly name = 'zhipu';
  protected readonly config: KodaXProviderConfig = buildProviderConfig('zhipu', {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-5.1', displayName: 'GLM-5.1' },
      // GLM-5 Turbo is the 128K-context budget tier; the GLM-5 / GLM-5.1
      // pair (provider default) is 200K. FEATURE_098 pin so compaction
      // doesn't overshoot when the user picks turbo.
      { id: 'glm-5-turbo', displayName: 'GLM-5 Turbo', contextWindow: 128_000 },
    ],
    supportsThinking: true,
    contextWindow: 200000,
    maxOutputTokens: 32768,
  });
  constructor() { super(); this.initClient(); }
}

// ============== Provider 工厂 ==============

export const KODAX_PROVIDERS: Record<string, () => KodaXBaseProvider> = {
  anthropic: () => new AnthropicProvider(),
  openai: () => new OpenAIProvider(),
  deepseek: () => new DeepSeekProvider(),
  kimi: () => new KimiProvider(),
  'kimi-code': () => new KimiCodeProvider(),
  qwen: () => new QwenProvider(),
  zhipu: () => new ZhipuProvider(),
  'zhipu-coding': () => new ZhipuCodingProvider(),
  'minimax-coding': () => new MiniMaxCodingProvider(),
  'mimo-coding': () => new MimoCodingProvider(),
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
  if (!factory) throw new KodaXProviderError(`Unknown provider: ${n}. Available: ${Object.keys(KODAX_PROVIDERS).join(', ')}`, n);

  const apiKeyEnv = resolveApiKeyEnvForProvider(n);
  const currentApiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;

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
  return !!process.env[KODAX_PROVIDER_SNAPSHOTS[name].apiKeyEnv];
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

  return snapshot.modelReasoningCapabilities?.[effectiveModel]
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
  capabilityProfile: KodaXProviderCapabilityProfile;
}> {
  const result: Array<{
    name: string;
    model: string;
    models: string[];
    configured: boolean;
    reasoningCapability: KodaXReasoningCapability;
    capabilityProfile: KodaXProviderCapabilityProfile;
  }> = [];
  for (const name of Object.keys(KODAX_PROVIDERS) as ProviderName[]) {
    const snapshot = KODAX_PROVIDER_SNAPSHOTS[name];
    result.push({
      name,
      model: snapshot.model,
      models: snapshot.models ? [snapshot.model, ...snapshot.models] : [snapshot.model],
      configured: !!process.env[snapshot.apiKeyEnv],
      reasoningCapability: snapshot.reasoningCapability,
      capabilityProfile: cloneCapabilityProfile(snapshot.capabilityProfile),
    });
  }
  return result;
}

// 获取内置 Provider 的可用模型列表（不需要实例化 Provider，不依赖 API Key）
export function getProviderModels(name: string): string[] {
  const snapshot = KODAX_PROVIDER_SNAPSHOTS[name as ProviderName];
  if (!snapshot) return [];
  return snapshot.models ? [snapshot.model, ...snapshot.models] : [snapshot.model];
}

// 类型守卫函数：检查字符串是否为有效的 Provider 名称
export function isProviderName(name: string): name is ProviderName {
  return name in KODAX_PROVIDERS;
}

export { normalizeCapabilityProfile };
