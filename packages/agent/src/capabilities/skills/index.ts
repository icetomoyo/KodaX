/**
 * Skills Module Entry Point
 *
 * Implements Agent Skills standard (https://agentskills.io/)
 * with Claude Code compatibility
 */

// Types
export type {
  Skill,
  SkillMetadata,
  SkillFile,
  SkillFrontmatter,
  SkillHook,
  SkillHooks,
  SkillSource,
  ResolvedSkillSource,
  SkillContext,
  SkillDynamicContextExecutor,
  SkillResult,
  SkillArtifact,
  SkillPathsConfig,
  LearnedSkillDiscoveryConfig,
  ISkillRegistry,
  IVariableResolver,
} from './types.js';

export {
  getDefaultSkillPaths,
  getSkillPathsFlat,
} from './types.js';

export {
  registerPluginSkillPath,
  unregisterPluginSkillPath,
  listPluginSkillPaths,
  clearPluginSkillPaths,
} from './plugin-paths.js';

// Skill Loader
export {
  parseSkillMarkdown,
  loadSkillMetadata,
  loadFullSkill,
  loadSkillFileContent,
} from './skill-loader.js';

// Discovery
export {
  discoverSkills,
  discoverSkillsWithMonorepo,
  getNestedSkillPaths,
} from './discovery.js';
export type { DiscoveryResult } from './discovery.js';

// Resolver
export {
  VariableResolver,
  createResolver,
  resolveSkillContent,
  parseArguments,
} from './skill-resolver.js';

// Registry
export {
  SKILL_CATALOG_INSTRUCTIONS,
  formatSkillsSystemPrompt,
  SkillRegistry,
  getSkillRegistry,
  initializeSkillRegistry,
  resetSkillRegistry,
} from './skill-registry.js';

// Executor
export {
  SkillExecutor,
  createExecutor,
  executeSkill,
} from './executor.js';
export type { ExecutionMode, ExecutionOptions } from './executor.js';

// Expander
export {
  expandSkillForLLM,
  formatSkillActivationMessage,
} from './skill-expander.js';
export type { SkillExpansionResult } from './skill-expander.js';

export {
  dispatchSkillCreatorTool,
  isSkillCreatorDispatchAction,
} from './skill-creator-dispatcher.js';
