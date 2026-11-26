/**
 * Skill Discovery - Multi-path skill scanning
 *
 * Discovers skills from multiple paths with priority handling.
 * Supports nested directory discovery for monorepos.
 */

import { readdir, realpath, stat } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import type {
  ResolvedSkillSource,
  SkillMetadata,
  SkillPathsConfig,
} from './types.js';
import { getDefaultSkillPaths, getSkillPathsFlat } from './types.js';
import { loadSkillMetadata } from './skill-loader.js';
import { emitKodaXDiagnostic } from '../../diagnostics.js';

// === Skill Discovery ===

/**
 * Result of skill discovery
 */
export interface DiscoveryResult {
  skills: Map<string, SkillMetadata>;
  errors: Array<{ path: string; error: string }>;
  /** Stat stamp of every scanned directory and SKILL.md, taken before it was read. */
  sourceStamps: ReadonlyMap<string, string>;
}

/** Cheap change marker for a Skill source path; a missing path is a stable state. */
export async function readSkillSourceStamp(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch (error) {
    // Discovery reports unreadable sources itself; the stamp only has to change when they do.
    return typeof error === 'object' && error !== null && 'code' in error ? `error:${String(error.code)}` : 'error';
  }
}

/**
 * Discover all skills from configured paths
 */
export async function discoverSkills(
  projectRoot?: string,
  customPaths?: Partial<SkillPathsConfig>
): Promise<DiscoveryResult> {
  const skills = new Map<string, SkillMetadata>();
  const errors: Array<{ path: string; error: string }> = [];
  const sourceStamps = new Map<string, string>();
  const register = (skill: SkillMetadata) => {
    const selected = skills.get(skill.name);
    if (!selected) skills.set(skill.name, skill);
    else if (comparablePath(selected.path) !== comparablePath(skill.path)) {
      emitKodaXDiagnostic({ source: 'agent:skills', level: 'warn',
        message: `Skill "${skill.name}" is shadowed by a higher-priority source.`,
        detail: { code: 'skill_shadowed', name: skill.name,
          selectedPath: join(selected.path, 'SKILL.md'), shadowedPath: join(skill.path, 'SKILL.md') } });
    }
  };

  // Get skill paths
  const defaultPaths = getDefaultSkillPaths(projectRoot);
  const config: SkillPathsConfig = {
    ...defaultPaths,
    ...customPaths,
  };

  const pathsFlat = getSkillPathsFlat(config);

  // Scan each path in priority order
  for (const { path, source } of pathsFlat) {
    try {
      const discovered = await scanSkillDirectory(path, source, errors, sourceStamps);

      for (const skill of discovered) {
        register(skill);
      }
    } catch (error) {
      errors.push({
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { skills, errors, sourceStamps };
}

function comparablePath(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Scan a directory for skills
 */
async function scanSkillDirectory(
  dirPath: string,
  source: ResolvedSkillSource,
  errors: DiscoveryResult['errors'],
  sourceStamps: Map<string, string>,
): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = [];
  const visited = new Set<string>();
  async function visit(directory: string): Promise<void> {
    try {
      sourceStamps.set(directory, await readSkillSourceStamp(directory));
      const physicalPath = comparablePath(await realpath(directory));
      if (visited.has(physicalPath)) return;
      visited.add(physicalPath);
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.some(entry => entry.name === 'SKILL.md')) {
        const skillFile = join(directory, 'SKILL.md');
        sourceStamps.set(skillFile, await readSkillSourceStamp(skillFile));
        const metadata = await loadSkillMetadata(directory, source);
        if (metadata) skills.push(metadata);
        else errors.push({ path: join(directory, 'SKILL.md'), error: 'Skill metadata could not be loaded.' });
        // A Skill's support files are not independent catalog entries.
        return;
      }
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const entryPath = join(directory, entry.name);
        try {
          if (entry.isDirectory() || (entry.isSymbolicLink() && (await stat(entryPath)).isDirectory())) {
            await visit(entryPath);
          }
        } catch (error) {
          recordDiscoveryError(errors, entryPath, error);
        }
      }
    } catch (error) {
      recordDiscoveryError(errors, directory, error);
    }
  }
  await visit(dirPath);
  return skills;
}

function recordDiscoveryError(errors: DiscoveryResult['errors'], path: string, error: unknown): void {
  // Optional absent sources and ordinary non-Skill folders remain harmless.
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
  errors.push({ path, error: error instanceof Error ? error.message : String(error) });
}

/**
 * Get nested skill paths for monorepo support
 * When in a subdirectory, also check parent directories for skills
 */
export function getNestedSkillPaths(
  currentDir: string,
  projectRoot: string
): string[] {
  const paths: string[] = [];
  const skillDirNames = ['.kodax/skills', '.agents/skills'];

  // Start from current directory and walk up to project root
  let dir = currentDir;
  const root = dirname(projectRoot);

  while (dir !== root && dir !== '/' && dir.length > 3) {
    for (const skillDir of skillDirNames) {
      paths.push(join(dir, skillDir));
    }

    const parent = dirname(dir);
    if (parent === dir) break; // Reached filesystem root
    dir = parent;
  }

  return paths;
}

/**
 * Discover skills with monorepo support
 */
export async function discoverSkillsWithMonorepo(
  currentDir: string,
  projectRoot: string
): Promise<DiscoveryResult> {
  // Get nested paths
  const nestedPaths = getNestedSkillPaths(currentDir, projectRoot);

  // Add nested paths to project paths
  const customPaths: Partial<SkillPathsConfig> = {
    projectPaths: [
      join(projectRoot, '.kodax', 'skills'),
      ...nestedPaths,
    ],
  };

  return discoverSkills(projectRoot, customPaths);
}

/**
 * Watch for skill changes (for hot reload)
 * Note: For now, this is a placeholder. Full implementation would use fs.watch
 */
export function createSkillWatcher(
  _paths: SkillPathsConfig,
  _onChange: () => void
): { stop: () => void } {
  // Placeholder for hot reload functionality
  // Full implementation would use fs.watch on skill directories
  return {
    stop: () => {
      // No-op for now
    },
  };
}
