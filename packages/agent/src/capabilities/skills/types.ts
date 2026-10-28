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
  /** @deprecated Enabled skills are always explicitly user-invocable. */
  userInvocable?: boolean;
  /** Tool restrictions, e.g., "Read, Grep, Bash(python *)"; shell patterns match the full command. */
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
  /** @deprecated Enabled skills always report true and support explicit invocation. */
  userInvocable: boolean;
  argumentHint?: string;
  path: string;
  source: ResolvedSkillSource;
  readonly learned?: {
    readonly capabilityId: string;
    readonly revision: number;
    readonly fingerprint: string;
  };
  /** If true, exclude from system prompt; still invokable by explicit slash forms. */
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
  source: ResolvedSkillSource;
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

/** Runtime discovery output; learned Skills remain lower precedence than formal sources. */
export type ResolvedSkillSource = SkillSource | 'learned';

// === Skill Registry ===

/**
 * Skill registry interface for managing discovered skills
 */
export interface ISkillRegistry {
  /** At least one trusted source could not be scanned; absence is not conclusive. */
  readonly discoveryIncomplete?: boolean;
  /** Read-only view of discovered skill metadata */
  readonly skills: ReadonlyMap<string, SkillMetadata>;

  /** Discover skills from all configured paths */
  discover(): Promise<void>;

  /** Get skill metadata by name */
  get(name: string): SkillMetadata | undefined;

  /** Load full skill content */
  loadFull(name: string): Promise<Skill>;

  /** Explicitly invoke a skill with arguments; model admission is a caller concern. */
  invoke(name: string, args: string, context: SkillContext): Promise<SkillResult>;

  /** Reload skills from disk */
  reload(): Promise<void>;

  /** List all discovered skills */
  list(): ReadonlyArray<SkillMetadata>;

  /** List enabled skills available for explicit user invocation. */
  listUserInvocable(): ReadonlyArray<SkillMetadata>;

  /** Check whether a skill exists */
  has(name: string): boolean;

  /** Number of discovered skills */
  readonly size: number;
}

// === Skill Execution Context ===

/**
 * v0.7.42 — SDK-embedder hook for `!`cmd`` dynamic context resolution.
 *
 * Receives the literal command string and the working directory the resolver
 * would have used. Must return the command's text output (which the resolver
 * splices into the skill markdown in place of the `!`cmd`` token), or throw
 * to deny.
 *
 * **Trust boundary**: when the KodaX SDK is embedded inside a host app
 * (e.g. KodaX Space, IDE extensions), the host typically mediates shell
 * execution through a permission broker so the end user can approve / deny
 * each command. Without this hook, `VariableResolver` directly `execSync`s
 * commands using its own built-in whitelist — bypassing the host's broker
 * and producing OS side-effects the user never saw.
 *
 * Embedders should route here to:
 *   - prompt the user via their own UI,
 *   - log execution to their audit trail,
 *   - apply policy (e.g. block network commands),
 *   - or refuse outright (throw).
 *
 * @example
 * ```ts
 * const context: SkillContext = {
 *   workingDirectory: '/repo',
 *   executeDynamicContext: async (cmd, cwd) => {
 *     const approved = await brokerAskUser({ kind: 'skill-cmd', command: cmd, cwd });
 *     if (!approved) throw new Error('user denied');
 *     return await brokerExecute(cmd, cwd);
 *   },
 * };
 * ```
 */
export type SkillDynamicContextExecutor = (
  command: string,
  cwd: string,
) => Promise<string>;

export interface SkillContext {
  workingDirectory: string;
  projectRoot?: string;
  /**
   * Optional. Used to substitute `${CLAUDE_SESSION_ID}` / `${KODAX_SESSION_ID}`
   * template variables in skill markdown. Tool-invocation callers (e.g. the
   * `skill` tool) may not have a session bound — in that case the resolver
   * falls back to an empty replacement so the substitution doesn't leak the
   * literal `${...}` to the LLM.
   */
  sessionId?: string;
  environment?: Record<string, string>;
  messages?: unknown[];
  /**
   * v0.7.42 — SDK-embedder hook for `!`cmd`` dynamic-context resolution.
   * See {@link SkillDynamicContextExecutor} for the trust-boundary rationale.
   * When present, completely replaces the built-in `execSync`-based path
   * (whitelist + 5s timeout). When absent, the legacy whitelist path runs.
   */
  executeDynamicContext?: SkillDynamicContextExecutor;
  /** Runtime Skill restrictions, checked on the fully substituted command before either executor. */
  assertDynamicContextAllowed?: (command: string) => void;
  /**
   * v0.7.42 — hard-disable `!`cmd`` resolution.
   * When `true`, encountering a `!`cmd`` token throws
   * `[Dynamic context disabled by host]` regardless of any hook. Useful for
   * embedders that want a single-flag kill switch without writing a hook.
   * `executeDynamicContext` is ignored when this is `true`.
   */
  disableDynamicContext?: boolean;
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
  /**
   * Deprecated loose-file path. It remains in the public shape for source
   * compatibility but is intentionally not discovered without a manifest.
   */
  learnedPath?: string;
  learnedArea?: LearnedSkillDiscoveryConfig;
}

export interface LearnedSkillDiscoveryScope {
  readonly configHomeHash: string;
  readonly tenantHash: string;
  readonly projectHash: string;
}

interface LearnedSkillDiscoveryConfigBase {
  readonly rootDir: string;
  /** Additional identity-specific Learned Areas, in fallback precedence order. */
  readonly additionalRootDirs?: readonly string[];
  readonly testingBindings?: Readonly<Record<string, string>>;
  readonly now?: string;
}

export interface LearnedSkillDiscoveryConfig extends LearnedSkillDiscoveryConfigBase {
  /**
   * Primary identity scope. Kept required so existing consumers can both
   * construct and read the original public configuration shape unchanged.
   */
  readonly expectedScope: LearnedSkillDiscoveryScope;
  /**
   * One or more identity scopes paired with rootDir/additionalRootDirs.
   * Multi-scope support resolves the non-deterministic divergence between
   * `remote:*` (git remote available) and `local:*` (git remote unavailable)
   * project identities within the same repository.
   */
  readonly expectedScopes?: readonly [
    LearnedSkillDiscoveryScope,
    ...LearnedSkillDiscoveryScope[],
  ];
}

// === Default Skill Paths ===

import { homedir } from 'os';
import { existsSync } from 'node:fs';
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
  const local = path.join(__dirname, 'builtin');
  const distribution = path.join(__dirname, '..', 'builtin');
  return !existsSync(local) && existsSync(distribution) ? distribution : local;
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
 * Learned Skills are supplied separately through a record-gated Learned Area
 * and never through a loose directory.
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
 * Priority: Project > User > Plugin > Builtin. Record-gated Learned Skills
 * are appended by discovery after these formal sources.
 * - Project: Project-specific skills override everything else
 * - User: User preferences (~/.kodax/ and ~/.agents/)
 * - Plugin: Third-party plugins
 * - Builtin: Default skills shipped with KodaX
 * - Learned: Runtime-governed Skills, always lower precedence than formal sources
 */
export function getSkillPathsFlat(config: SkillPathsConfig): Array<{ path: string; source: ResolvedSkillSource }> {
  const result: Array<{ path: string; source: ResolvedSkillSource }> = [];

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
