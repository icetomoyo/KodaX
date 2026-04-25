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
  /** Model preference: haiku, sonnet, opus, or a provider-specific model id */
  model?: string;
  /** Hooks scoped to this skill's lifecycle */
  hooks?: SkillHooks;

  // === Metadata fields ===
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
}

export interface SkillHook {
  matcher?: string;
  command: string;
}

export interface SkillHooks {
  SessionStart?: SkillHook[];
  UserPromptSubmit?: SkillHook[];
  PreToolUse?: SkillHook[];
  PostToolUse?: SkillHook[];
  Stop?: SkillHook[];
  SubagentStop?: SkillHook[];
  Notification?: SkillHook[];
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
  /** If true, exclude from system prompt (only invokable via /skill:name) */
  disableModelInvocation: boolean;
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
  references?: SkillFile[];
  assets?: SkillFile[];
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
  | 'project' // <projectRoot>/.kodax/skills/
  | 'user' // ~/.kodax/skills/ or ~/.agent/skills/
  | 'plugin' // Plugin-provided skills
  | 'builtin'; // Built-in skills

// === Skill Registry ===

/**
 * Skill registry interface for managing discovered skills
 */
export interface ISkillRegistry {
  /** Read-only view of discovered skill metadata */
  readonly skills: ReadonlyMap<string, SkillMetadata>;

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

  /** List all discovered skills */
  list(): ReadonlyArray<SkillMetadata>;

  /** List skills that can be invoked directly by users */
  listUserInvocable(): ReadonlyArray<SkillMetadata>;

  /** Check whether a skill exists */
  has(name: string): boolean;

  /** Number of discovered skills */
  readonly size: number;
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
  projectPaths: string[];
  userPaths: string[];
  pluginPaths: string[];
  builtinPath: string;
}

// === Default Skill Paths ===

import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { listPluginSkillPaths } from './plugin-paths.js';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the builtin skills directory.
 *
 * Two distribution modes:
 *  - npm / dev / `bun run` / `node dist/...` → relative to this module's __dirname
 *    (i.e. `packages/skills/dist/builtin/`, populated by `npm run copy:builtin`).
 *  - Bun --compile standalone binary → sidecar `builtin/` next to the executable,
 *    detected via the build-time `KODAX_BUNDLED` flag (injected via `--define`
 *    so consumers without the flag continue using __dirname unchanged).
 */
function resolveBuiltinPath(): string {
  if (process.env.KODAX_BUNDLED === 'true') {
    return path.join(path.dirname(process.execPath), 'builtin');
  }
  return path.join(__dirname, 'builtin');
}

/**
 * Get default skill discovery paths
 *
 * Priority order (highest first):
 * 1. Project - <projectRoot>/.kodax/skills/
 * 2. User - ~/.kodax/skills/
 * 3. User - ~/.agents/skills/ (AgentSkills standard)
 * 4. Plugin - (dynamic)
 * 5. Builtin - packages/skills/src/builtin/
 */
export function getDefaultSkillPaths(projectRoot?: string): SkillPathsConfig {
  const home = homedir();

  return {
    // Project-level (highest priority) - .kodax/skills/
    projectPaths: projectRoot
      ? [
          path.join(projectRoot, '.kodax', 'skills'),
        ]
      : [],

    // User-level - ~/.kodax/skills/ and ~/.agents/skills/
    userPaths: [
      path.join(home, '.kodax', 'skills'),
      path.join(home, '.agents', 'skills'),
    ],

    // Plugin-level (runtime-provided)
    pluginPaths: listPluginSkillPaths(),

    // Built-in skills
    builtinPath: resolveBuiltinPath(),
  };
}

/**
 * All skill paths in priority order (highest to lowest)
 *
 * Priority: Project > User > Plugin > Builtin
 * - Project: Project-specific skills override everything else
 * - User: User preferences (~/.kodax/ and ~/.agents/)
 * - Plugin: Third-party plugins
 * - Builtin: Default skills shipped with KodaX
 */
export function getSkillPathsFlat(config: SkillPathsConfig): Array<{ path: string; source: SkillSource }> {
  const result: Array<{ path: string; source: SkillSource }> = [];

  // Highest priority first - skills found first win
  for (const p of config.projectPaths) {
    result.push({ path: p, source: 'project' });
  }
  for (const p of config.userPaths) {
    result.push({ path: p, source: 'user' });
  }
  for (const p of config.pluginPaths) {
    result.push({ path: p, source: 'plugin' });
  }
  result.push({ path: config.builtinPath, source: 'builtin' });

  return result;
}
