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
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
} from './types.js';

// ============== Errors ==============
export { KodaXError, KodaXProviderError, KodaXRateLimitError } from './errors.js';

// ============== Constants ==============
export { KODAX_MAX_TOKENS, KODAX_API_MIN_INTERVAL } from './constants.js';

// ============== Providers ==============
export {
  KodaXBaseProvider,
  KodaXAnthropicCompatProvider,
  KodaXOpenAICompatProvider,
  KODAX_PROVIDERS,
  KODAX_DEFAULT_PROVIDER,
  getProvider,
  isProviderConfigured,
  getProviderModel,
  getProviderList,
  isProviderName,
} from './providers/index.js';
export type { ProviderName } from './providers/index.js';
