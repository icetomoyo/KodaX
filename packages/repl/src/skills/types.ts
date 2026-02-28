/**
 * Agent Skills Standard Type Definitions
 * Compliant with https://agentskills.io/ specification
 *
 * Also supports Claude Code extension fields for compatibility
 */

// === YAML Frontmatter Fields ===

/**
 * Skill frontmatter as defined in SKILL.md YAML header
 */
export interface SkillFrontmatter {
  // === Required fields (Agent Skills standard) ===
  /** Skill name in kebab-case, max 64 characters */
  name: string;
  /** Skill description, max 1024 characters, should include trigger conditions */
  description: string;

  // === Claude Code extension fields ===
  /** Whether to disable automatic model invocation (default: false) */
  disableModelInvocation?: boolean;
  /** Whether skill appears in / menu (default: true) */
  userInvocable?: boolean;
  /** Tool restrictions, e.g., "Read, Grep, Bash(python:*)" */
  allowedTools?: string;
  /** Execution context - 'fork' for sub-agent execution */
  context?: 'fork';
  /** Sub-agent type: Explore, Plan, general-purpose, etc. */
  agent?: string;
  /** Argument hint for UI, e.g., "[file] [format]" */
  argumentHint?: string;
  /** Model preference: haiku, sonnet, opus */
  model?: 'haiku' | 'sonnet' | 'opus';

  // === Metadata fields ===
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
}

// === Skill Metadata (Level 1 - Preloaded) ===

/**
 * Lightweight skill metadata for system prompt injection
 * Loaded at startup for progressive disclosure
 */
export interface SkillMetadata {
  name: string;
  description: string;
  userInvocable: boolean;
  argumentHint?: string;
  path: string;
  source: SkillSource;
}

// === Full Skill Definition ===

/**
 * Complete skill definition with all content loaded
 */
export interface Skill extends SkillFrontmatter {
  /** Skill directory absolute path */
  path: string;
  /** SKILL.md absolute path */
  skillFilePath: string;

  /** Markdown content (with variables resolved) */
  content: string;
  /** Raw markdown content (before variable resolution) */
  rawContent: string;

  /** Support files */
  scripts?: SkillFile[];
  templates?: SkillFile[];
  resources?: SkillFile[];

  /** Runtime state */
  loaded: boolean;
  source: SkillSource;
}

/**
 * File within a skill directory
 */
export interface SkillFile {
  name: string;
  path: string;
  relativePath: string;
  content?: string; // Loaded on demand
}

// === Skill Sources ===

export type SkillSource =
  | 'enterprise' // ~/.kodax/skills/enterprise/
  | 'user' // ~/.kodax/skills/
  | 'project' // .kodax/skills/
  | 'plugin' // Plugin-provided skills
  | 'builtin'; // Built-in skills

// === Skill Registry ===

/**
 * Skill registry interface for managing discovered skills
 */
export interface ISkillRegistry {
  /** All discovered skill metadata */
  skills: Map<string, SkillMetadata>;

  /** Discover skills from all configured paths */
  discover(): Promise<void>;

  /** Get skill metadata by name */
  get(name: string): SkillMetadata | undefined;

  /** Load full skill content */
  loadFull(name: string): Promise<Skill>;

  /** Invoke a skill with arguments */
  invoke(name: string, args: string, context: SkillContext): Promise<SkillResult>;

  /** Reload skills from disk */
  reload(): Promise<void>;
}

// === Skill Execution Context ===

export interface SkillContext {
  workingDirectory: string;
  projectRoot?: string;
  sessionId: string;
  environment?: Record<string, string>;
  messages?: unknown[];
}

// === Skill Execution Result ===

export interface SkillResult {
  success: boolean;
  /** Processed prompt content */
  content: string;
  /** Generated artifacts */
  artifacts?: SkillArtifact[];
  error?: string;
}

export interface SkillArtifact {
  type: 'file' | 'code' | 'text';
  name: string;
  content: string;
  path?: string;
}

// === Variable Resolver ===

export interface IVariableResolver {
  /** Resolve all variables in content */
  resolve(content: string, args: string, context: SkillContext): Promise<string>;
}

// === Skill Paths Configuration ===

export interface SkillPathsConfig {
  enterprisePaths: string[];
  userPaths: string[];
  projectPaths: string[];
  pluginPaths: string[];
  builtinPath: string;
}

// === Default Skill Paths ===

import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Get default skill discovery paths
 */
export function getDefaultSkillPaths(projectRoot?: string): SkillPathsConfig {
  const home = homedir();

  return {
    // Enterprise-level (highest priority)
    enterprisePaths: [path.join(home, '.kodax', 'skills', 'enterprise')],

    // User-level - ~/.kodax/skills/
    userPaths: [
      path.join(home, '.kodax', 'skills'),
    ],

    // Project-level - .kodax/skills/
    projectPaths: projectRoot
      ? [
          path.join(projectRoot, '.kodax', 'skills'),
        ]
      : [],

    // Plugin-level (to be configured)
    pluginPaths: [],

    // Built-in skills
    builtinPath: path.join(__dirname, 'builtin'),
  };
}

/**
 * All skill paths in priority order (highest to lowest)
 */
export function getSkillPathsFlat(config: SkillPathsConfig): Array<{ path: string; source: SkillSource }> {
  const result: Array<{ path: string; source: SkillSource }> = [];

  for (const p of config.enterprisePaths) {
    result.push({ path: p, source: 'enterprise' });
  }
  for (const p of config.userPaths) {
    result.push({ path: p, source: 'user' });
  }
  for (const p of config.projectPaths) {
    result.push({ path: p, source: 'project' });
  }
  for (const p of config.pluginPaths) {
    result.push({ path: p, source: 'plugin' });
  }
  result.push({ path: config.builtinPath, source: 'builtin' });

  return result;
}
