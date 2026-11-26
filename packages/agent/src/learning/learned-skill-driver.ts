import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { emitKodaXDiagnostic } from '../diagnostics.js';

import type {
  LearnedCapabilityCanary,
  LearnedCapabilityRecord,
  LearnedCapabilityRecordV2,
  LearningAction,
  LearningActionDriver,
} from './center-types.js';
import {
  LearningCapabilityError,
  assertLearnedCapabilityTransition,
} from './center-types.js';
import { LearnedAreaStore } from './learned-area-store.js';
import { isLearnedCapabilityRecordV2 } from './learned-skill.js';

export interface CreateLearnedSkillActionDriverOptions {
  readonly learnedAreaRoot: string;
  readonly learnedAreaKind?: 'global' | 'project';
  readonly userSkillsRoot: string;
  readonly now?: () => string;
}

const DRIVER_ACTIONS = ['review', 'trust', 'rollback', 'promote'] as const;

/**
 * Explicit-user actions for one project Learned Area.
 *
 * The Learning Center invokes this driver while holding the carrier owner
 * lock, then commits the returned next record with the usual revision CAS.
 */
export function createLearnedSkillActionDriver(
  options: CreateLearnedSkillActionDriverOptions,
): LearningActionDriver {
  return {
    carrier: 'skill',
    actions: DRIVER_ACTIONS,
    execute: async (action, capability) => {
      const current = requireLearnedSkill(capability);
      const now = options.now?.() ?? new Date().toISOString();
      if (action === 'rollback') return rollbackRecord(current, now);
      if (action === 'review') {
        return transitionRecord(current, 'testing', now, {
          canary: resetCanary(),
          lastAction: action,
        });
      }
      if (action === 'trust') {
        return transitionRecord(current, 'active_learned', now, {
          previousGoodRevision: current.previousGoodRevision
            ?? current.artifact.contentRevision,
          previousGoodArtifact: current.previousGoodArtifact
            ?? current.artifact,
          lastAction: action,
        });
      }
      if (action === 'promote') {
        await promoteExactArtifact(options, current);
        if (current.lifecycle === 'promoted_user') return current;
        return transitionRecord(current, 'promoted_user', now, { lastAction: action });
      }
      throw new LearningCapabilityError(
        'unsupported_action',
        `unsupported learned Skill action: ${String(action)}`,
      );
    },
  };
}

/**
 * One-time copy of every approved (`active_learned`) learned Skill into
 * `<configHome>/skills/<slug>/SKILL.md`, because learned Skills no longer load
 * at runtime. Existing user Skills are never overwritten, `learned/` is only
 * read, and the marker in the user Skills root makes later calls a no-op.
 * Failures become diagnostics; nothing here may block startup.
 */
export async function importApprovedLearnedSkills(configHome: string): Promise<void> {
  const learnedAreaRoot = join(resolve(configHome), 'learned');
  const userSkillsRoot = join(resolve(configHome), 'skills');
  const marker = join(userSkillsRoot, '.learned-skills-imported.json');
  const report = (level: 'info' | 'warn', message: string, detail?: unknown) =>
    emitKodaXDiagnostic({ source: 'agent:learning', level, message, detail });
  try {
    if (await pathExists(marker) || !await pathExists(learnedAreaRoot)) return;
    const approved = (await new LearnedAreaStore(learnedAreaRoot).listCapabilities())
      .filter(isLearnedCapabilityRecordV2)
      .filter((record) => record.lifecycle === 'active_learned');
    const imported: string[] = [];
    const skipped: string[] = [];
    for (const record of approved) {
      try {
        await promoteExactArtifact({ learnedAreaRoot, learnedAreaKind: 'global', userSkillsRoot }, record);
        imported.push(record.slug);
      } catch (error) {
        skipped.push(record.slug);
        report('warn', `Learned Skill ${record.slug} was not copied to user Skills.`,
          error instanceof Error ? error.message : String(error));
      }
    }
    await mkdir(userSkillsRoot, { recursive: true });
    await writeFile(marker, `${JSON.stringify({ importedAt: new Date().toISOString(), imported, skipped }, null, 2)}\n`, 'utf8');
    if (imported.length > 0) report('info', `Copied ${imported.length} approved learned Skills to user Skills.`, { imported });
  } catch (error) {
    report('warn', 'Approved learned Skills could not be copied to user Skills; retrying next start.',
      error instanceof Error ? error.message : String(error));
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return false;
    throw error;
  }
}

function requireLearnedSkill(
  capability: LearnedCapabilityRecord,
): LearnedCapabilityRecordV2 {
  if (!isLearnedCapabilityRecordV2(capability)
    || capability.source.kind !== 'skill_learning_loop') {
    throw new LearningCapabilityError(
      'unsupported_action',
      'the capability is not an F263 learned Skill',
    );
  }
  return capability;
}

function transitionRecord(
  current: LearnedCapabilityRecordV2,
  lifecycle: LearnedCapabilityRecordV2['lifecycle'],
  now: string,
  patch: Partial<LearnedCapabilityRecordV2>,
): LearnedCapabilityRecordV2 {
  if (current.lifecycle !== lifecycle) {
    assertLearnedCapabilityTransition(current.lifecycle, lifecycle);
  }
  return {
    ...current,
    ...patch,
    lifecycle,
    revision: current.revision + 1,
    updatedAt: now,
  };
}

function rollbackRecord(
  current: LearnedCapabilityRecordV2,
  now: string,
): LearnedCapabilityRecordV2 {
  if (current.previousGoodArtifact === undefined
    || current.previousGoodRevision === undefined) {
    throw new LearningCapabilityError(
      'invalid_transition',
      'learned Skill has no immutable previous good revision',
    );
  }
  const restoredArtifact = current.previousGoodArtifact;
  return {
    ...current,
    lifecycle: 'active_learned',
    revision: current.revision + 1,
    updatedAt: now,
    lastAction: 'rollback',
    artifactPath: restoredArtifact.relativePath,
    artifact: restoredArtifact,
    previousGoodRevision: restoredArtifact.contentRevision,
    previousGoodArtifact: restoredArtifact,
    previousLifecycle: current.lifecycle,
    canary: resetCanary(),
  };
}

function resetCanary(): LearnedCapabilityCanary {
  return {
    maxInvocations: 3,
    invocationCount: 0,
    verifiedSuccesses: 0,
    credibleNegatives: 0,
    invocations: [],
  };
}

async function promoteExactArtifact(
  options: CreateLearnedSkillActionDriverOptions,
  current: LearnedCapabilityRecordV2,
): Promise<void> {
  const learnedAreaRoot = capabilityAreaRoot(options, current);
  const source = resolve(
    learnedAreaRoot,
    ...current.artifact.relativePath.split('/'),
  );
  assertInside(source, learnedAreaRoot);
  await assertRegularFileChain(
    learnedAreaRoot,
    source,
    'learned Skill promotion source contains a symlink or non-regular path',
  );
  const content = await readFile(source, 'utf8');
  if (sha256(content) !== current.artifact.fingerprint) {
    throw new LearningCapabilityError(
      'store_integrity_error',
      'learned Skill promotion source fingerprint changed',
    );
  }
  const destination = await preparePromotionDestination(
    options.userSkillsRoot,
    current.slug,
  );
  assertInside(destination, options.userSkillsRoot);
  if (await publishFormalSkill(destination, content)) return;
  const destinationInfo = await lstat(destination);
  if (destinationInfo.isSymbolicLink() || !destinationInfo.isFile()) {
    throw new LearningCapabilityError(
      'store_integrity_error',
      'formal user Skill target is not a regular file',
    );
  }
  if (await readFile(destination, 'utf8') !== content) {
    throw new LearningCapabilityError(
      'action_failed',
      `formal user Skill already exists with different content: ${current.slug}`,
    );
  }
}

async function publishFormalSkill(
  destination: string,
  content: string,
): Promise<boolean> {
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
      return true;
    } catch (error) {
      if (isFileError(error, 'EEXIST')) return false;
      throw error;
    }
  } finally {
    try {
      await handle?.close();
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function preparePromotionDestination(
  userSkillsRoot: string,
  slug: string,
): Promise<string> {
  const root = resolve(userSkillsRoot);
  await mkdir(root, { recursive: true });
  await assertRegularDirectory(root, 'formal user Skill root is not a regular directory');
  const skillDir = resolve(root, slug);
  assertInside(skillDir, root);
  try {
    await mkdir(skillDir);
  } catch (error) {
    if (!isFileError(error, 'EEXIST')) throw error;
  }
  await assertRegularDirectory(
    skillDir,
    'formal user Skill path contains a symlink or non-regular directory',
  );
  return join(skillDir, 'SKILL.md');
}

async function assertRegularFileChain(
  rootDir: string,
  target: string,
  message: string,
): Promise<void> {
  const root = resolve(rootDir);
  await assertRegularDirectory(root, message);
  const parts = relative(root, target).split(sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    const final = index === parts.length - 1;
    if (info.isSymbolicLink() || (final ? !info.isFile() : !info.isDirectory())) {
      throw new LearningCapabilityError('store_integrity_error', message);
    }
  }
}

async function assertRegularDirectory(path: string, message: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new LearningCapabilityError('store_integrity_error', message);
  }
}

function capabilityAreaRoot(
  options: CreateLearnedSkillActionDriverOptions,
  current: LearnedCapabilityRecordV2,
): string {
  const normalized = resolve(options.learnedAreaRoot);
  if (options.learnedAreaKind === 'project'
    || (options.learnedAreaKind === undefined && normalized.endsWith(join(
      'projects',
      current.scope.tenantHash,
      current.scope.projectHash,
    )))) {
    return normalized;
  }
  return join(
    normalized,
    'projects',
    current.scope.tenantHash,
    current.scope.projectHash,
  );
}

function assertInside(target: string, rootDir: string): void {
  const root = comparable(rootDir);
  const candidate = comparable(target);
  if (candidate !== root
    && !candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    throw new LearningCapabilityError(
      'store_integrity_error',
      'learned Skill path escaped its configured owner root',
    );
  }
}

function comparable(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
