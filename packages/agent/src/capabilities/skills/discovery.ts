/**
 * Skill Discovery - Multi-path skill scanning
 *
 * Discovers skills from multiple paths with priority handling.
 * Supports nested directory discovery for monorepos.
 */

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'fs/promises';
import { join, dirname, relative, resolve, sep } from 'path';
import {
  LearnedAreaStore,
  isLearnedCapabilityRecordV2,
  type LearnedCapabilityRecordV2,
} from '../../learning/index.js';
import type {
  LearnedSkillDiscoveryConfig,
  LearnedSkillDiscoveryScope,
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
      const discovered = await scanSkillDirectory(path, source, errors);

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
  if (config.learnedArea !== undefined) {
    const learned = await scanRecordGatedLearnedArea(config.learnedArea);
    errors.push(...learned.errors);
    for (const skill of learned.skills) {
      register(skill);
    }
  }

  return { skills, errors };
}

async function scanRecordGatedLearnedArea(
  config: LearnedSkillDiscoveryConfig,
): Promise<{
  readonly skills: readonly SkillMetadata[];
  readonly errors: readonly { path: string; error: string }[];
}> {
  const skills: SkillMetadata[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  for (const binding of learnedAreaBindings(config)) {
    const discovered = await scanRecordGatedLearnedRoot(
      binding.rootDir,
      binding.expectedScope,
      config,
    );
    skills.push(...discovered.skills);
    errors.push(...discovered.errors);
  }
  return { skills, errors };
}

async function scanRecordGatedLearnedRoot(
  rootDir: string,
  expectedScope: LearnedSkillDiscoveryScope,
  config: LearnedSkillDiscoveryConfig,
): Promise<{
  readonly skills: readonly SkillMetadata[];
  readonly errors: readonly { path: string; error: string }[];
}> {
  const store = new LearnedAreaStore(rootDir);
  const skills: SkillMetadata[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  let records: readonly import('../../learning/index.js').LearnedCapabilityRecord[];
  try {
    records = await store.listCapabilities();
  } catch (error) {
    return {
      skills,
      errors: [{
        path: rootDir,
        error: error instanceof Error ? error.message : String(error),
      }],
    };
  }
  for (const record of records) {
    if (!isLearnedCapabilityRecordV2(record) || !scopeMatches(record, expectedScope)) continue;
    if (!isRecordAdmitted(record, config)) continue;
    const artifactPath = resolve(rootDir, ...record.artifact.relativePath.split('/'));
    try {
      assertInside(artifactPath, rootDir);
      await assertRegularArtifactChain(rootDir, artifactPath);
      const content = await readFile(artifactPath, 'utf8');
      if (sha256(content) !== record.artifact.fingerprint) {
        throw new Error('learned Skill artifact fingerprint mismatch');
      }
      const metadata = await loadSkillMetadata(dirname(artifactPath), 'learned');
      if (metadata === null) throw new Error('learned Skill metadata is invalid');
      skills.push({
        ...metadata,
        learned: {
          capabilityId: record.capabilityId,
          revision: record.artifact.contentRevision,
          fingerprint: record.artifact.fingerprint,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ path: artifactPath, error: message });
      await quarantineInvalidLearnedArtifact(store, record, message);
    }
  }
  return { skills, errors };
}

function learnedAreaBindings(config: LearnedSkillDiscoveryConfig): readonly {
  readonly rootDir: string;
  readonly expectedScope: LearnedSkillDiscoveryScope;
}[] {
  const roots = [config.rootDir, ...(config.additionalRootDirs ?? [])];
  const scopes = expectedLearnedScopes(config);
  if (roots.length !== scopes.length) {
    throw new Error('learned Skill discovery requires one expected scope per physical root');
  }
  const bindings = roots.map((rootDir, index) => ({
    rootDir,
    expectedScope: scopes[index]!,
  }));
  for (const [index, binding] of bindings.entries()) {
    const duplicate = bindings.findIndex((candidate) => (
      comparablePath(candidate.rootDir) === comparablePath(binding.rootDir)
    ));
    if (duplicate !== index) {
      throw new Error('learned Skill discovery physical roots must be unique');
    }
  }
  return bindings;
}

function scopeMatches(
  record: LearnedCapabilityRecordV2,
  expectedScope: LearnedSkillDiscoveryScope,
): boolean {
  return record.scope.configHomeHash === expectedScope.configHomeHash
    && record.scope.tenantHash === expectedScope.tenantHash
    && record.scope.projectHash === expectedScope.projectHash;
}

function expectedLearnedScopes(
  config: LearnedSkillDiscoveryConfig,
): readonly LearnedSkillDiscoveryScope[] {
  const expectedScopes = [
    ...(config.expectedScopes ?? [config.expectedScope]),
  ];
  if (expectedScopes.length === 0) {
    throw new Error('learned Skill discovery requires at least one expected scope');
  }
  return expectedScopes;
}

function isRecordAdmitted(
  record: LearnedCapabilityRecordV2,
  config: LearnedSkillDiscoveryConfig,
): boolean {
  if (record.lifecycle === 'active_learned') return true;
  if (record.lifecycle !== 'testing') return false;
  const bindingId = config.testingBindings?.[record.capabilityId];
  const binding = record.canary.binding;
  return bindingId !== undefined
    && binding?.bindingId === bindingId
    && Date.parse(binding.expiresAt) > Date.parse(config.now ?? new Date().toISOString());
}

async function quarantineInvalidLearnedArtifact(
  store: LearnedAreaStore,
  observed: LearnedCapabilityRecordV2,
  reason: string,
): Promise<void> {
  await store.withOwnerMutation(async () => {
    const current = await store.readCapability(observed.capabilityId);
    if (current === undefined
      || !isLearnedCapabilityRecordV2(current)
      || current.revision !== observed.revision
      || (current.lifecycle !== 'testing' && current.lifecycle !== 'active_learned')) return;
    const next: LearnedCapabilityRecordV2 = {
      ...current,
      lifecycle: 'quarantined',
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      diagnostics: [...(current.diagnostics ?? []), `artifact discovery rejected: ${reason}`],
    };
    await store.writeCapability(next);
    await store.ensureCurrentEvent(next);
  });
}

async function assertRegularArtifactChain(rootDir: string, artifactPath: string): Promise<void> {
  const relativePath = relative(resolve(rootDir), artifactPath);
  const parts = relativePath.split(sep);
  let current = resolve(rootDir);
  const rootInfo = await lstat(current);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('learned Skill root is not a regular directory');
  }
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    const final = index === parts.length - 1;
    if (info.isSymbolicLink()
      || (final ? !info.isFile() : !info.isDirectory())) {
      throw new Error('learned Skill artifact contains a symlink or non-regular path');
    }
  }
}

function assertInside(target: string, rootDir: string): void {
  const root = comparablePath(rootDir);
  const candidate = comparablePath(target);
  if (candidate !== root && !candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    throw new Error('learned Skill artifact escapes its Learned Area');
  }
}

function comparablePath(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Scan a directory for skills
 */
async function scanSkillDirectory(
  dirPath: string,
  source: ResolvedSkillSource,
  errors: DiscoveryResult['errors'],
): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = [];
  const visited = new Set<string>();
  async function visit(directory: string): Promise<void> {
    try {
      const physicalPath = comparablePath(await realpath(directory));
      if (visited.has(physicalPath)) return;
      visited.add(physicalPath);
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.some(entry => entry.name === 'SKILL.md')) {
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
