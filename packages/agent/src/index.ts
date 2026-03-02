/**
 * @kodax/agent
 *
 * 通用 Agent 框架 - 会话管理和消息处理
 *
 * 这个包提供了通用的 Agent 功能：
 * - 会话 ID 生成和标题提取
 * - Token 估算
 * - 消息压缩
 * - 通用常量配置
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
  KodaXSessionMeta,
  KodaXSessionStorage,
} from './types.js';

// ============== Constants ==============
export {
  KODAX_MAX_TOKENS,
  KODAX_DEFAULT_TIMEOUT,
  KODAX_HARD_TIMEOUT,
  KODAX_COMPACT_THRESHOLD,
  KODAX_COMPACT_KEEP_RECENT,
  KODAX_MAX_RETRIES,
  KODAX_RETRY_BASE_DELAY,
  KODAX_MAX_INCOMPLETE_RETRIES,
  KODAX_STAGGER_DELAY,
  KODAX_API_MIN_INTERVAL,
  PROMISE_PATTERN,
} from './constants.js';

// ============== Session ==============
export {
  generateSessionId,
  extractTitleFromMessages,
} from './session.js';

// ============== Tokenizer ==============
export {
  estimateTokens,
} from './tokenizer.js';

// ============== Messages ==============
export {
  compactMessages,
} from './messages.js';
