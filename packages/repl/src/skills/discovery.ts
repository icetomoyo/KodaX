/**
 * Skill Discovery - Multi-path skill scanning
 *
 * Discovers skills from multiple paths with priority handling.
 * Supports nested directory discovery for monorepos.
 */

import { readdir, stat } from 'fs/promises';
import { join, dirname, basename } from 'path';
import type { SkillMetadata, SkillSource, SkillPathsConfig } from './types.js';
import { getDefaultSkillPaths, getSkillPathsFlat } from './types.js';
import { loadSkillMetadata } from './skill-loader.js';

// === Skill Discovery ===

/**
 * Result of skill discovery
 */
export interface DiscoveryResult {
  skills: Map<string, SkillMetadata>;
  errors: Array<{ path: string; error: string }>;
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
      const discovered = await scanSkillDirectory(path, source);

      for (const skill of discovered) {
        // Don't override if already found (higher priority)
        if (!skills.has(skill.name)) {
          skills.set(skill.name, skill);
        }
      }
    } catch (error) {
      errors.push({
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { skills, errors };
}

/**
 * Scan a directory for skills
 */
async function scanSkillDirectory(
  dirPath: string,
  source: SkillSource
): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = [];

  try {
    const dirStat = await stat(dirPath);
    if (!dirStat.isDirectory()) return skills;

    const entries = await readdir(dirPath);

    for (const entry of entries) {
      const entryPath = join(dirPath, entry);

      try {
        const entryStat = await stat(entryPath);

        if (entryStat.isDirectory()) {
          // Check if it's a skill directory (contains SKILL.md)
          const skillFile = join(entryPath, 'SKILL.md');
          try {
            const skillStat = await stat(skillFile);
            if (skillStat.isFile()) {
              const metadata = await loadSkillMetadata(entryPath, source);
              if (metadata) {
                skills.push(metadata);
              }
            }
          } catch {
            // Not a skill directory, skip
          }
        }
      } catch {
        // Skip entries we can't access
      }
    }
  } catch {
    // Directory doesn't exist or can't be accessed
  }

  return skills;
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
  // KodaX uses .kodax/skills/ directory
  const skillDirNames = ['.kodax/skills'];

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
