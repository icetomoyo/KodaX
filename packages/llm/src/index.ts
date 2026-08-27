/**
 * KodaX AI - 独立的 LLM 抽象层
 *
 * @description 可被其他项目复用的 LLM Provider 抽象层
 * @module @kodax-ai/llm
 */

// ============== Types ==============
export type {
  KodaXImageBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXToolResultContentItem,
  KodaXToolResultTextItem,
  KodaXToolResultImageItem,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXCacheBoundary,
  KodaXContentBlock,
  KodaXMessage,
  KodaXEphemeralSuffix,
  KodaXTaskResultMetadata,
  KodaXTaskResultSource,
  KodaXTokenUsage,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXModelDescriptor,
  KodaXProtocolFamily,
  KodaXOpenAICompatMaxOutputTokensField,
  KodaXCustomProviderConfig,
  KodaXProviderConfig,
  KodaXProviderTransport,
  KodaXProviderConversationSemantics,
  KodaXProviderMcpSupport,
  KodaXProviderContextFidelity,
  KodaXProviderToolCallingFidelity,
  KodaXProviderSessionSupport,
  KodaXProviderLongRunningSupport,
  KodaXProviderMultimodalSupport,
  KodaXProviderEvidenceSupport,
  KodaXProviderCapabilityProfile,
  KodaXProviderStreamOptions,
  KodaXReasoningCapability,
  KodaXStableEffortIntent,
  KodaXWireReasoningEffort,
  KodaXReasoningEffortRequest,
  KodaXReasoningEffortPreset,
  KodaXReasoningEffortWireStrategy,
  KodaXThinkingWireStrategy,
  KodaXReasoningProfile,
  KodaXReasoningMode,
  KodaXThinkingDepth,
  KodaXTaskType,
  KodaXExecutionMode,
  KodaXRiskLevel,
  KodaXTaskComplexity,
  KodaXTaskWorkIntent,
  KodaXTaskFamily,
  KodaXTaskActionability,
  KodaXExecutionPattern,
  KodaXMutationSurface,
  KodaXAssuranceIntent,
  KodaXHarnessProfile,
  KodaXChildFanoutClass,
  KodaXReviewScale,
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
  KodaXNormalizedReasoningRequest,
  // v0.7.45 FEATURE_216 credential verification surface.
  KodaXVerifyStrategy,
  KodaXVerifyCredentialResult,
  KodaXListModelsResult,
} from './types.js';

export {
  getScopedProviderCredential,
  redactScopedProviderCredential,
  runWithProviderCredential,
} from './provider-credential-context.js';

// ============== Errors ==============
export {
  KodaXError,
  KodaXProviderError,
  KodaXRateLimitError,
  KodaXNetworkError,
  KodaXToolCallIdError,
} from './errors.js';
export type { KodaXProviderErrorMetadata } from './errors.js';

// ============== Constants ==============
export {
  KODAX_MAX_TOKENS,
  KODAX_API_MIN_INTERVAL,
  KODAX_CAPPED_MAX_OUTPUT_TOKENS,
  KODAX_ESCALATED_MAX_OUTPUT_TOKENS,
} from './constants.js';

// ============== Timeout config ==============
export {
  parseTimeoutSecEnvMs,
  resolveLlmTimeoutConfig,
  timeoutSecToMs,
} from './timeouts.js';
export type {
  KodaXLlmTimeoutConfig,
  KodaXResolvedLlmTimeoutConfig,
} from './timeouts.js';

// ============== Capability learning ==============
export {
  addRejectedEffort,
  capabilityCacheKey,
  getRejectedEfforts,
  narrowReasoningProfile,
  removeCacheEntry,
  sanitizeCapabilityCache,
} from './capability-learning.js';
export type {
  CapabilityCache,
  CapabilityCacheEntry,
  CapabilityCacheSource,
} from './capability-learning.js';

// ============== Reasoning ==============
export {
  KODAX_REASONING_MODE_SEQUENCE,
  KODAX_STABLE_EFFORT_INTENTS,
  KODAX_DEFAULT_THINKING_BUDGETS,
  KODAX_REASONING_SAFETY_RESERVE,
  getReasoningCapability,
  isReasoningEnabled,
  normalizeReasoningRequest,
  normalizeReasoningEffortValue,
  mapLegacyReasoningModeToEffortIntent,
  effortToLegacyReasoningMode,
  parseReasoningEffortEnv,
  resolveReasoningEffort,
  resolveReasoningEffortForModelSwitch,
  getDefaultThinkingDepthForMode,
  resolveThinkingBudget,
  clampThinkingBudget,
  mapDepthToOpenAIReasoningEffort,
} from './reasoning.js';

// FEATURE_222 (R6) — canonical host-facing wire-effort resolver.
export { resolveWireEffort } from './wire-effort.js';
export type { ResolveWireEffortInput, ResolvedWireEffort } from './wire-effort.js';

// ============== Providers ==============
export {
  KodaXBaseProvider,
  KodaXAnthropicCompatProvider,
  KodaXOpenAICompatProvider,
  KodaXAcpProvider,
  KODAX_PROVIDERS,
  KODAX_PROVIDER_SNAPSHOTS,
  KODAX_DEFAULT_PROVIDER,
  getProvider,
  getProviderConfiguredCapabilityProfile,
  getProviderConfiguredReasoningCapability,
  normalizeCapabilityProfile,
  isProviderConfigured,
  getProviderModel,
  getProviderModels,
  getProviderList,
  isProviderName,
  createCustomProvider,
  validateCustomProviderConfig,
  registerCustomProviders,
  getCustomProvider,
  getCustomProviderCapabilityProfile,
  isCustomProviderName,
  getCustomProviderNames,
  getCustomProviderList,
  getCustomProviderModels,
  registerModelProvider,
  getRuntimeModelProvider,
  isRuntimeModelProviderName,
  getRuntimeModelProviderNames,
  getRuntimeModelProviderCredentialEnvironmentNames,
  clearRuntimeModelProviders,
  resolveProvider,
  isKnownProvider,
  getAvailableProviderNames,
  getProviderCredentialEnvironmentNames,
  // v0.7.43 SDK model-capability exposure (built-in + custom, no API key needed).
  getProviderModelDescriptors,
  getModelCapabilities,
  listBuiltinModelCapabilities,
  getCustomProviderModelDescriptors,
  getCustomModelCapabilities,
  listCustomProviderModelCapabilities,
  resolveProviderModelDescriptors,
  resolveModelCapabilities,
  listAllModelCapabilities,
  // v0.7.45 FEATURE_216 SDK credential verification + model listing.
  verifyProviderCredential,
  listProviderModels,
  runVerifyCredential,
  classifyVerifyError,
} from './providers/index.js';
export type { ProviderName, KodaXModelCapabilities } from './providers/index.js';
export type {
  VerifyPrimitiveRunner,
  RunVerifyCredentialOpts,
} from './providers/index.js';
export {
  getCodexCliDefaultModel,
  getCodexCliKnownModels,
  getGeminiCliDefaultModel,
  getGeminiCliKnownModels,
} from './providers/cli-bridge-models.js';

// Tool-use input salvage helper. Exposed publicly for custom providers
// that extend KodaXBaseProvider directly (i.e. don't inherit the
// stream() implementation from KodaXAnthropicCompatProvider /
// KodaXOpenAICompatProvider) and therefore need to parse truncated
// `arguments` / `input_json_delta` buffers themselves on
// `stop_reason: max_tokens` / `finish_reason: length`. Same helper
// builtin compat paths use, so behavior stays consistent across
// transports. See `tool-input-parser.ts` JSDoc for the salvage strategy.
export { parseToolInputWithSalvage } from './providers/tool-input-parser.js';

// FEATURE_240 (v0.7.56): provider-neutral consumer-side stopReason classifier.
export { classifyStopReason, isCleanStop } from './stop-reason.js';

// Run-scoped config (concurrency-safe per-run overrides via AsyncLocalStorage).
export {
  runWithScopedConfig,
  getRunScopedConfig,
  resolvePromptCacheDisabled,
  resolveWorkflowMaxConcurrency,
  WORKFLOW_MAX_CONCURRENCY_DEFAULT,
  WORKFLOW_MAX_CONCURRENCY_ABSOLUTE,
} from './run-scoped-config.js';
export type { KodaXRunScopedConfig } from './run-scoped-config.js';
export type { KodaXStopClass } from './stop-reason.js';

// ============== Cost Tracking ==============
export { DEFAULT_COST_RATES, getCostRate, calculateCost } from './cost-rates.js';
export type { CostRate } from './cost-rates.js';

export {
  createCostTracker,
  recordUsage,
  recordRetry,
  getSummary,
  formatCost,
  formatCostReport,
} from './cost-tracker.js';
export type {
  TokenUsageRecord,
  RetryRecord,
  ProviderCostSummary,
  SessionCostSummary,
  CostTracker,
} from './cost-tracker.js';

// ============== Side Query (independent one-shot LLM invocation) ==============
export { sideQuery } from './side-query.js';
export type {
  SideQueryRequest,
  SideQueryResult,
  SideQueryStopReason,
  SideQueryDiagnostics,
  SideQueryTerminalPhase,
} from './side-query.js';

// ============== Retry-After helper (FEATURE_130, v0.7.36) ==============
// Cross-provider Retry-After header parsing. Used inside the base
// provider's `withRateLimit` path so all built-in provider adapters get
// 4-form coverage (integer seconds / HTTP-date / Anthropic
// `retry-after-ms` / exponential backoff fallback) without touching
// each adapter individually. Re-exported so external consumers (custom
// providers, the REPL spinner, the cost tracker) can read the same
// shape that fires through `KodaXEvents.onRetryAfter`.
export { parseRetryAfter, extractHeadersFromError } from './retry/retry-after.js';
export type {
  ParseRetryAfterOptions,
  RetryAfterResult,
  RetryAfterSource,
} from './retry/retry-after.js';

// FEATURE_116 (v0.7.37) — cache boundary helpers. Producer side
// (`insertCacheBoundary`) is called by prompt assembly; consumer side
// (`lowerCacheBoundaries` / `stripCacheBoundaries`) is called by
// provider base classes during request lowering.
export {
  insertCacheBoundary,
  isCacheBoundary,
  lowerCacheBoundaries,
  stripCacheBoundaries,
} from './cache-control.js';
export type {
  KodaXAnthropicCacheableBlock,
  KodaXCacheLowerMode,
} from './cache-control.js';
export type {
  KodaXRetryAfterEvent,
  KodaXOnRetryAfterCallback,
} from './providers/base.js';

// ============== Capability Provider (absorbed from @kodax-ai/core in v0.7.35.1 FEATURE_142) ==============
// Originally extracted from @kodax-ai/coding/src/extensions/types.ts in FEATURE_082 (v0.7.24).
// Lives in @kodax-ai/llm because CapabilityProvider is the provider-shaped contract
// for data sources (MCP/RAG/custom indexes). The richer extension runtime
// (commands / files / logger) stays in @kodax-ai/coding/src/extensions/.
export type {
  CapabilityKind,
  CapabilityProvider,
  CapabilityResult,
  CapabilitySearchFailure,
  CapabilitySearchFreshness,
  CapabilitySearchOptions,
  CapabilitySearchSnapshot,
} from './capability.js';
