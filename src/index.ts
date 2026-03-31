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
  ProjectStorage,
  type ProjectFeature,
  type ProjectState,
  type ProjectStatistics,
  type FeatureList,
  calculateStatistics,
  getNextPendingIndex,
  isAllCompleted,
  handleProjectCommand,
  detectAndShowProjectHint,
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
  getFeatureProgress,
  checkAllFeaturesComplete,
  rateLimitedCall,
  buildInitPrompt,
  KODAX_DIR,
  KODAX_SESSIONS_DIR,
  KODAX_CONFIG_FILE,
  runWithPlanMode,
  listPlans,
  resumePlan,
  clearCompletedPlans,
  PlanStorage,
  planStorage,
  type ExecutionPlan,
  FileSessionStorage,
} from '@kodax/repl';
