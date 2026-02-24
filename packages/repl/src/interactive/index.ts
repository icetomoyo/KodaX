/**
 * KodaX 交互式模块
 */

export { runInteractiveMode, processSpecialSyntax, type RepLOptions } from './repl.js';
export {
  InteractiveContext,
  InteractiveMode,
  createInteractiveContext,
  touchContext,
} from './context.js';
export {
  parseCommand,
  executeCommand,
  BUILTIN_COMMANDS,
  type Command,
  type CommandCallbacks,
  type CurrentConfig,
} from './commands.js';
export {
  ProjectStorage,
} from './project-storage.js';
export {
  ProjectFeature,
  ProjectState,
  ProjectStatistics,
  FeatureList,
  calculateStatistics,
  getNextPendingIndex,
  isAllCompleted,
} from './project-state.js';
export {
  handleProjectCommand,
  detectAndShowProjectHint,
} from './project-commands.js';
