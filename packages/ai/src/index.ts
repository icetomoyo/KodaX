/**
 * KodaX AI - 独立的 LLM 抽象层
 *
 * @description 可被其他项目复用的 LLM Provider 抽象层
 * @module @kodax/ai
 */

// ============== Types ==============
export type {
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXContentBlock,
  KodaXMessage,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXModelDescriptor,
  KodaXProtocolFamily,
  KodaXCustomProviderConfig,
  KodaXProviderConfig,
  KodaXProviderTransport,
  KodaXProviderConversationSemantics,
  KodaXProviderMcpSupport,
  KodaXProviderCapabilityProfile,
  KodaXProviderStreamOptions,
  KodaXReasoningCapability,
  KodaXReasoningOverride,
  KodaXReasoningMode,
  KodaXThinkingDepth,
  KodaXTaskType,
  KodaXExecutionMode,
  KodaXRiskLevel,
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
export { KODAX_MAX_TOKENS, KODAX_API_MIN_INTERVAL } from './constants.js';

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
  resolveProvider,
  isKnownProvider,
  getAvailableProviderNames,
} from './providers/index.js';
export type { ProviderName } from './providers/index.js';
