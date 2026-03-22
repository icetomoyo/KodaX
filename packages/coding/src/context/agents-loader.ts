/**
 * AGENTS.md - Project-level AI Context Rules Loader
 *
 * This module implements loading of project-level context rules from AGENTS.md files,
 * inspired by pi-mono's implementation.
 *
 * Priority: global < root < ... < current directory < .kodax/
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";

const CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];

export interface AgentsFile {
  path: string;
  content: string;
  scope: 'global' | 'project' | 'directory';
}

export interface LoadAgentsOptions {
  /** Pass cwd explicitly for deterministic prompt building; process.cwd() is only a legacy fallback. */
  cwd?: string;
  kodaxDir?: string;
  projectRoot?: string;
}

/**
 * Get KodaX global directory
 */
export function getKodaxGlobalDir(): string {
  return join(homedir(), ".kodax");
}

function loadAgentsFile(dir: string, filenames: readonly string[]): AgentsFile | null {
  for (const filename of filenames) {
    const filePath = join(dir, filename);
    if (existsSync(filePath)) {
      try {
        return {
          path: filePath,
          content: readFileSync(filePath, "utf-8"),
          scope: "directory", // Will be adjusted by caller if needed
        };
      } catch (error) {
        console.warn(`[kodax:agents] Could not read ${filePath}: ${error}`);
      }
    }
  }
  return null;
}

/**
 * Load context file from a directory
 * Priority: AGENTS.md > CLAUDE.md
 */
function loadContextFileFromDir(dir: string): AgentsFile | null {
  return loadAgentsFile(dir, CONTEXT_FILE_CANDIDATES);
}

/**
 * Load all AGENTS files
 * Priority: global < root < ... < current directory < .kodax/
 */
export function loadAgentsFiles(options?: LoadAgentsOptions): AgentsFile[] {
  const resolvedCwd = resolve(options?.cwd ?? process.cwd());
  const resolvedKodaxDir = options?.kodaxDir ?? getKodaxGlobalDir();
  const resolvedProjectRoot = options?.projectRoot ? resolve(options.projectRoot) : null;
  const traversalRoot = resolvedProjectRoot ?? parse(resolvedCwd).root;

  const contextFiles: AgentsFile[] = [];
  const seenPaths = new Set<string>();

  // 1. Load global config (~/.kodax/AGENTS.md only)
  const globalContext = loadAgentsFile(resolvedKodaxDir, ["AGENTS.md"]);
  if (globalContext) {
    globalContext.scope = "global";
    contextFiles.push(globalContext);
    seenPaths.add(globalContext.path);
  }

  // 2. Traverse from project root to current directory
  const directoryFiles: AgentsFile[] = [];
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
