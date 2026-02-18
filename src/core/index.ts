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

// 类型导出
export type {
  KodaXContentBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXMessage,
  KodaXSessionMeta,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXEvents,
  KodaXSessionOptions,
  KodaXContextOptions,
  KodaXOptions,
  KodaXResult,
  KodaXSessionStorage,
  KodaXToolExecutionContext,
  KodaXConfig,
} from './types.js';

// 错误导出
export {
  KodaXError,
  KodaXProviderError,
  KodaXToolError,
  KodaXRateLimitError,
  KodaXSessionError,
} from './errors.js';

// 常量导出
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

// Provider 导出
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
  ProviderName,
  isProviderName,
} from './providers/index.js';

// 工具导出
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

// 提示词导出
export {
  SYSTEM_PROMPT,
  LONG_RUNNING_PROMPT,
  buildSystemPrompt,
} from './prompts/index.js';

// 会话导出
export {
  generateSessionId,
  extractTitleFromMessages,
} from './session.js';

// 消息处理导出
export {
  compactMessages,
  checkIncompleteToolCalls,
} from './messages.js';

// Tokenizer 导出
export {
  estimateTokens,
} from './tokenizer.js';

// Agent 导出
export {
  runKodaX,
  checkPromiseSignal,
  KodaXClient,
} from './agent.js';

// Client 单独导出
export { KodaXClient as Client } from './client.js';
