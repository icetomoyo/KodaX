/**
 * @kodax/repl - KodaX 完整的交互式终端体验
 *
 * 提供两个入口：
 * - Ink UI (推荐): 现代化 React 终端 UI
 * - 传统 REPL: Node.js readline 实现
 */

// === 主入口：Ink UI ===
export { runInkInteractiveMode } from "./ui/index.js";
export type { InkREPLOptions } from "./ui/index.js";

// === 传统 REPL 入口 ===
export { runInteractiveMode, processSpecialSyntax, type RepLOptions } from "./interactive/repl.js";

// === UI 组件 ===
export * from "./ui/index.js";

// === 交互式命令系统 ===
export {
  InteractiveContext,
  InteractiveMode,
  createInteractiveContext,
  touchContext,
} from "./interactive/context.js";
export {
  parseCommand,
  executeCommand,
  BUILTIN_COMMANDS,
  type Command,
  type CommandCallbacks,
  type CurrentConfig,
} from "./interactive/commands.js";

// === 项目管理 ===
export { ProjectStorage } from "./interactive/project-storage.js";
export {
  ProjectFeature,
  ProjectState,
  ProjectStatistics,
  FeatureList,
  calculateStatistics,
  getNextPendingIndex,
  isAllCompleted,
} from "./interactive/project-state.js";
export {
  handleProjectCommand,
  detectAndShowProjectHint,
} from "./interactive/project-commands.js";

// === 共享工具 ===
export {
  getVersion,
  KODAX_VERSION,
  getProviderModel,
  getProviderList,
  isProviderConfigured,
  loadConfig,
  saveConfig,
  getGitRoot,
  getFeatureProgress,
  checkAllFeaturesComplete,
  rateLimitedCall,
  buildInitPrompt,
  KODAX_DIR,
  KODAX_SESSIONS_DIR,
  KODAX_CONFIG_FILE,
  PREVIEW_MAX_LENGTH,
} from "./common/utils.js";
export {
  runWithPlanMode,
  listPlans,
  resumePlan,
  clearCompletedPlans,
} from "./common/plan-mode.js";
export {
  PlanStorage,
  planStorage,
  type ExecutionPlan,
} from "./common/plan-storage.js";

// === 会话存储 ===
export { FileSessionStorage } from "./interactive/storage.js";
