/**
 * KodaX AI - 独立的 LLM 抽象层
 *
 * @description 可被其他项目复用的 LLM Provider 抽象层
 * @module @kodax/ai
 */

// ============== Types ==============
export type {
  KodaXImageBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXContentBlock,
  KodaXMessage,
  KodaXTokenUsage,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXModelDescriptor,
  KodaXProtocolFamily,
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
  KodaXReasoningOverride,
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
  KodaXAmaProfile,
  KodaXAmaTactic,
  KodaXAmaFanoutClass,
  KodaXAmaFanoutPolicy,
  KodaXAmaControllerDecision,
  KodaXReviewScale,
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
} from './types.js';

// ============== Errors ==============
export {
  KodaXError,
  KodaXProviderError,
  KodaXRateLimitError,
  KodaXNetworkError,
  KodaXToolCallIdError,
} from './errors.js';

// ============== Constants ==============
export {
  KODAX_MAX_TOKENS,
  KODAX_API_MIN_INTERVAL,
  KODAX_CAPPED_MAX_OUTPUT_TOKENS,
  KODAX_ESCALATED_MAX_OUTPUT_TOKENS,
} from './constants.js';

// ============== Reasoning ==============
export {
  KODAX_REASONING_MODE_SEQUENCE,
  KODAX_DEFAULT_THINKING_BUDGETS,
  KODAX_REASONING_SAFETY_RESERVE,
  getReasoningCapability,
  isReasoningEnabled,
  normalizeReasoningRequest,
  getDefaultThinkingDepthForMode,
  resolveThinkingBudget,
  clampThinkingBudget,
  mapDepthToOpenAIReasoningEffort,
} from './reasoning.js';

export {
  buildReasoningOverrideKey,
  loadReasoningOverride,
  saveReasoningOverride,
  clearReasoningOverride,
  reasoningCapabilityToOverride,
  reasoningOverrideToCapability,
} from './reasoning-overrides.js';

// ============== Providers ==============
export {
  KodaXBaseProvider,
  KodaXAnthropicCompatProvider,
  KodaXOpenAICompatProvider,
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
  registerCustomProviders,
  getCustomProvider,
  isCustomProviderName,
  getCustomProviderNames,
  getCustomProviderList,
  getCustomProviderModels,
  registerModelProvider,
  getRuntimeModelProvider,
  isRuntimeModelProviderName,
  getRuntimeModelProviderNames,
  clearRuntimeModelProviders,
  resolveProvider,
  isKnownProvider,
  getAvailableProviderNames,
} from './providers/index.js';
export type { ProviderName } from './providers/index.js';
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

// ============== Cost Tracking ==============
export { DEFAULT_COST_RATES, getCostRate, calculateCost } from './cost-rates.js';
export type { CostRate } from './cost-rates.js';

export {
  createCostTracker,
  recordUsage,
  getSummary,
  formatCost,
  formatCostReport,
} from './cost-tracker.js';
export type {
  TokenUsageRecord,
  ProviderCostSummary,
  SessionCostSummary,
  CostTracker,
} from './cost-tracker.js';
