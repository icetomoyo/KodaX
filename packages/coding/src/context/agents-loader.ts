/**
 * Project instructions from AGENTS.md and scoped Markdown rules.
 *
 * This module implements loading of project-level context rules from AGENTS.md files,
 * inspired by pi-mono's implementation.
 *
 * Priority: user rules < user AGENTS < project rules < root ... cwd AGENTS < .kodax/AGENTS
 */

import { readFileSync, statSync } from "node:fs";
import { join, parse, resolve } from "node:path";

import { getAgentConfigHome } from "@kodax-ai/agent";
import { clearRulesLoaderCache, loadRulesFiles, type RulesLoadOptions } from './rules-loader.js';

// v0.7.38 (2026-05-09) — KodaX only reads `AGENTS.md`, never `CLAUDE.md`.
//
// Rationale: `CLAUDE.md` is Claude Code-specific project guidance (its content
// is authored to be consumed by the Claude Code CLI). When a project ships
// both files, the contents typically overlap — falling back to `CLAUDE.md`
// when `AGENTS.md` is missing causes either (a) double-injection of the same
// rules (when both exist + fallback by directory order), or (b) semantic
// mis-match (KodaX agent receives Claude Code-targeted instructions). KodaX's
// own repository dogfooded this bug: `docs/CLAUDE.md` is CC project rules and
// must NOT be injected into KodaX agent context.
//
// Practical impact: projects that ONLY ship `CLAUDE.md` (no `AGENTS.md`)
// stop receiving any project-agents section. Migration: rename to
// `AGENTS.md` or symlink — `AGENTS.md` is the canonical AI-agent rules file
// across the AI-agent ecosystem (KodaX, Cursor, Continue, …).
const CONTEXT_FILE_CANDIDATES = ["AGENTS.md"];

export interface AgentsFile {
  path: string;
  content: string;
  scope: 'global' | 'project' | 'directory';
}

/** Ordered prompt sources; scope describes precedence, kind describes the editable file. */
export type InstructionFile =
  | (AgentsFile & { readonly kind: 'agents' })
  | { readonly kind: 'rule'; path: string; content: string; scope: 'global' | 'project' };

export interface LoadAgentsOptions extends RulesLoadOptions {
  /** Pass cwd explicitly for deterministic prompt building; process.cwd() is only a legacy fallback. */
  cwd?: string;
  kodaxDir?: string;
  projectRoot?: string;
  /** Original project root for local fragments inherited by isolated worktrees. */
  projectRulesRoot?: string;
}

/**
 * Get KodaX global directory.
 *
 * Routes through {@link getAgentConfigHome} (v0.7.35.1 FEATURE_145 3-tier
 * resolution: programmatic override > KODAX_HOME env > ~/.kodax default).
 */
export function getKodaxGlobalDir(): string {
  return getAgentConfigHome();
}

/**
 * FEATURE_149 Phase 1.2 (v0.7.38) — mtime-based file content cache.
 *
 * `loadAgentsFiles` is on the hot path (called by `prompts/capability-sections.ts`
 * for every agent round). Without caching, each round walked from cwd to the
 * filesystem root calling `existsSync` + `readFileSync` at each level. Now we
 * stat first, hit the cache if mtime matches, and only re-read when the file
 * actually changed. Mirrors Claude Code's `services/claudemd.ts` + `utils/fileReadCache.ts`
 * pattern.
 *
 * Cache key = absolute path. `mtimeMs` is treated as the version. Cache is
 * module-singleton — survives across calls within a single process. Tests can
 * reset via `clearAgentsLoaderCacheForTesting()`.
 */
const fileContentCache = new Map<string, { mtimeMs: number; content: string }>();

/** Clear cached instruction files and rule listings for an explicit reload. */
export function clearAgentsLoaderCache(): void {
  fileContentCache.clear();
  clearRulesLoaderCache();
}

export const clearAgentsLoaderCacheForTesting = clearAgentsLoaderCache;
function readFileWithMtimeCache(filePath: string): string | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    // File does not exist or is not stat-able — treat as absent.
    fileContentCache.delete(filePath);
    return null;
  }

  const cached = fileContentCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.content;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    fileContentCache.set(filePath, { mtimeMs, content });
    return content;
  } catch {
    // Read fail-after-stat-success is rare (race with delete, EACCES) —
    // treat as absent to match the pre-FEATURE_149 silent behavior.
    // KodaX project rule (CLAUDE.md): no console.log/warn in production.
    fileContentCache.delete(filePath);
    return null;
  }
}

function loadAgentsFile(dir: string, filenames: readonly string[]): Extract<InstructionFile, { kind: 'agents' }> | null {
  for (const filename of filenames) {
    const filePath = join(dir, filename);
    const content = readFileWithMtimeCache(filePath);
    if (content !== null) {
      return {
        kind: 'agents',
        path: filePath,
        content,
        scope: "directory", // Will be adjusted by caller if needed
      };
    }
  }
  return null;
}

/**
 * Load context file from a directory.
 *
 * Only reads `AGENTS.md` — `CLAUDE.md` is intentionally NOT a fallback;
 * see the rationale on `CONTEXT_FILE_CANDIDATES` above.
 */
function loadContextFileFromDir(dir: string): Extract<InstructionFile, { kind: 'agents' }> | null {
  return loadAgentsFile(dir, CONTEXT_FILE_CANDIDATES);
}

/**
 * Load AGENTS and Markdown fragments. Empty rules directories preserve the
 * existing AGENTS prompt. Deeper AGENTS can refine project-wide fragments.
 */
export function loadInstructionFiles(options?: LoadAgentsOptions): InstructionFile[] {
  return loadFiles(options, true);
}

/** Legacy editor contract: only AGENTS.md files, without reading rule fragments. */
export function loadAgentsFiles(options?: LoadAgentsOptions): AgentsFile[] {
  return loadFiles(options, false).map(({ path, content, scope }) => ({ path, content, scope }));
}

function loadFiles(options: LoadAgentsOptions | undefined, includeRules: boolean): InstructionFile[] {
  const resolvedCwd = resolve(options?.cwd ?? process.cwd());
  const resolvedKodaxDir = options?.kodaxDir ?? getKodaxGlobalDir();
  const resolvedProjectRoot = options?.projectRoot ? resolve(options.projectRoot) : null;
  const traversalRoot = resolvedProjectRoot ?? parse(resolvedCwd).root;

  const contextFiles: InstructionFile[] = [];
  const seenPaths = new Set<string>();

  const globalRules = includeRules ? loadRulesFiles(join(resolvedKodaxDir, 'rules'), resolvedKodaxDir, 'global', options ?? {}) : [];
  for (const file of globalRules) {
    contextFiles.push(file);
    seenPaths.add(file.path);
  }

  // 1. Load global config (~/.kodax/AGENTS.md only)
  const globalContext = loadAgentsFile(resolvedKodaxDir, ["AGENTS.md"]);
  if (globalContext) {
    globalContext.scope = "global";
    contextFiles.push(globalContext);
    seenPaths.add(globalContext.path);
  }

  const rulesProjectRoot = options?.projectRulesRoot
    ? resolve(options.projectRulesRoot)
    : resolvedProjectRoot ?? resolvedCwd;
  for (const file of includeRules ? loadRulesFiles(
    join(rulesProjectRoot, '.kodax', 'rules'), rulesProjectRoot, 'project', options ?? {},
  ) : []) {
    if (seenPaths.has(file.path)) continue;
    contextFiles.push(file);
    seenPaths.add(file.path);
  }

  // 2. Traverse from project root to current directory
  const directoryFiles: InstructionFile[] = [];
  let currentDir = resolvedCwd;
  const visitedDirs = new Set<string>();

  while (true) {
    if (visitedDirs.has(currentDir)) break;
    visitedDirs.add(currentDir);

    // Directory-level files are appended from root -> cwd so deeper rules override earlier ones.
    const contextFile = loadContextFileFromDir(currentDir);
    if (contextFile && !seenPaths.has(contextFile.path)) {
      contextFile.scope = "directory";
      directoryFiles.unshift(contextFile);
      seenPaths.add(contextFile.path);
    }

    if (currentDir === traversalRoot) break;

    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  contextFiles.push(...directoryFiles);

  // 3. Project-level config from .kodax/AGENTS.md always has highest priority within the project.
  if (resolvedProjectRoot) {
    const projectContext = loadAgentsFile(join(resolvedProjectRoot, ".kodax"), ["AGENTS.md"]);
    if (projectContext && !seenPaths.has(projectContext.path)) {
      projectContext.scope = "project";
      contextFiles.push(projectContext);
    }
  }

  return contextFiles;
}

/**
 * Format AGENTS files for system prompt
 */
export function formatAgentsForPrompt(files: AgentsFile[]): string {
  if (files.length === 0) {
    return '';
  }

  const contextSections = files.map(file => {
    const scopeLabel = {
      'global': 'Global Rules',
      'project': 'Project Rules',
      'directory': 'Directory Rules'
    }[file.scope];

    return `
## ${scopeLabel} (from ${file.path})

${file.content}
`;
  }).join('\n---\n');

  return `
---

# Project Context

${contextSections}
`;
}
