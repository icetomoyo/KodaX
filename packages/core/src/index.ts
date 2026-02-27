/**
 * KodaX Core
 *
 * 极致轻量化 Coding Agent Core 层
 * 可作为独立库使用，零 UI 依赖
 *
 * @example
 * ```typescript
 * import { runKodaX } from 'kodax/core';
 *
 * const result = await runKodaX(
 *   { provider: 'anthropic', events: {} },
 *   "创建一个 HTTP 服务器"
 * );
 * ```
 */

// ============== Re-export from @kodax/ai ==============
// AI types are re-exported for backward compatibility
// New code should import directly from @kodax/ai

export type {
  KodaXContentBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXMessage,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
} from '@kodax/ai';

export {
  KodaXError,
  KodaXProviderError,
  KodaXRateLimitError,
} from '@kodax/ai';

// ============== Core Types ==============

export type {
  KodaXSessionMeta,
  KodaXEvents,
  KodaXSessionOptions,
  KodaXContextOptions,
  KodaXOptions,
  KodaXResult,
  KodaXSessionStorage,
  KodaXToolExecutionContext,
} from './types.js';

// ============== Core Errors ==============

export {
  KodaXToolError,
  KodaXSessionError,
  KodaXTerminalError,
} from './errors.js';

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
  KODAX_FEATURES_FILE,
  KODAX_PROGRESS_FILE,
  KODAX_TOOL_REQUIRED_PARAMS,
} from './constants.js';

// ============== Provider (re-export from @kodax/ai) ==============

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

// ============== Tools ==============

export {
  type ToolHandler,
  type ToolRegistry,
  KODAX_TOOLS,
  registerTool,
  getTool,
  listTools,
  executeTool,
  toolRead,
  toolWrite,
  toolEdit,
  toolBash,
  toolGlob,
  toolGrep,
  toolUndo,
} from './tools/index.js';

// ============== Prompts ==============

export {
  SYSTEM_PROMPT,
  LONG_RUNNING_PROMPT,
  buildSystemPrompt,
} from './prompts/index.js';

// ============== Session ==============

export {
  generateSessionId,
  extractTitleFromMessages,
} from './session.js';

// ============== Message Processing ==============

export {
  compactMessages,
  checkIncompleteToolCalls,
} from './messages.js';

// ============== Tokenizer ==============

export {
  estimateTokens,
} from './tokenizer.js';

// ============== Agent ==============

export {
  runKodaX,
  checkPromiseSignal,
  KodaXClient,
} from './agent.js';

// Client alias
export { KodaXClient as Client } from './client.js';
