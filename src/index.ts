/**
 * KodaX - 极致轻量化 Coding Agent
 *
 * 根入口文件 - 代理到 monorepo packages
 */

// Core API - 从 @kodax/coding 重新导出
export * from '@kodax/coding';
export {
  ACP_LOG_LEVELS,
  AcpLogger,
  resolveAcpLogLevel,
  type AcpLogLevel,
} from './acp_logger.js';
export {
  AcpEventEmitter,
  type AcpEventSink,
  type AcpRuntimeEvent,
} from './acp_events.js';
// ACP server API - server `cwd` can pin the session-level executionCwd for prompts and tools.
export { KodaXAcpServer, runAcpServer, type KodaXAcpServerOptions } from './acp_server.js';

// REPL API - 从 @kodax/repl 重新导出
export {
  runInkInteractiveMode,
  type InkREPLOptions,
  runInteractiveMode,
  processSpecialSyntax,
  type RepLOptions,
  InteractiveContext,
  createInteractiveContext,
  touchContext,
  parseCommand,
  executeCommand,
  BUILTIN_COMMANDS,
  type Command,
  type CommandCallbacks,
  type CurrentConfig,
  getVersion,
  KODAX_VERSION,
  getProviderModel,
  getProviderList,
  isProviderConfigured,
  hydrateProcessEnvFromShell,
  loadConfig,
  prepareRuntimeConfig,
  registerConfiguredCustomProviders,
  saveConfig,
  getGitRoot,
  rateLimitedCall,
  KODAX_DIR,
  KODAX_SESSIONS_DIR,
  KODAX_CONFIG_FILE,
  FileSessionStorage,
} from '@kodax/repl';
