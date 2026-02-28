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
  SkillSource,
  SkillContext,
  SkillResult,
  SkillArtifact,
  SkillPathsConfig,
  ISkillRegistry,
  IVariableResolver,
} from './types.js';

export {
  getDefaultSkillPaths,
  getSkillPathsFlat,
} from './types.js';

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
