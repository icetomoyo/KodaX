import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import type {
  LearnedCapabilityArtifact,
  LearnedCapabilityCanaryBinding,
  LearnedCapabilityCanaryInvocation,
  LearnedCapabilityProvenance,
  LearnedCapabilityRecord,
  LearnedCapabilityRecordV2,
  LearnedCapabilityScope,
} from './center-types.js';
import { LearningCapabilityError, slugifyLearnedCapabilityName } from './center-types.js';
import { LearnedAreaStore } from './learned-area-store.js';

const MAX_LEARNED_SKILL_BYTES = 16 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/;
const UNSAFE_PATTERNS: readonly RegExp[] = [
  /!\s*`/i,
  /\b(?:allowed-tools|hooks|context|agent|model)\s*:/i,
  /\b(?:ignore|override|disregard)\b.{0,80}\b(?:previous|system|developer|instructions?)\b/i,
  /\b(?:act as|become)\s+(?:the\s+)?(?:system|developer|administrator|root)\b/i,
  /\b(?:always|by default)\b.{0,80}\b(?:upload|send|post|exfiltrate)\b/i,
  /\b(?:disable|bypass|ignore)\b.{0,80}\b(?:permission|approval|guardrail|policy)\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:sk|rk)-[a-z0-9_-]{24,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|passwd|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S{8,}/i,
];

export interface DeclarativeSkillSpec {
  readonly name: string;
  readonly description: string;
  readonly purpose: string;
  readonly triggers: readonly string[];
  readonly steps: readonly string[];
  readonly verification: readonly string[];
  readonly pitfalls: readonly string[];
}

export interface StagedLearnedSkillArtifact extends LearnedCapabilityArtifact {
  readonly absolutePath: string;
}

export interface CreateLearnedSkillRecordInput {
  readonly capabilityId: string;
  readonly displayName: string;
  readonly scope: LearnedCapabilityScope;
  readonly artifact: LearnedCapabilityArtifact;
  readonly provenance: LearnedCapabilityProvenance;
  readonly now?: string;
  readonly previous?: LearnedCapabilityRecordV2;
}

export interface CommitLearnedSkillRevisionInput {
  readonly scope: LearnedCapabilityScope;
  readonly spec: DeclarativeSkillSpec;
  readonly disposition: 'ready' | 'project_canary';
  readonly operation: 'create' | 'patch';
  readonly provenance: LearnedCapabilityProvenance;
  readonly targetCapabilityId?: string;
  readonly expectedRevision?: number;
  readonly expectedFingerprint?: string;
  readonly protectedSkillNames?: readonly string[];
  readonly now?: string;
  readonly authority?: {
    readonly commit: (
      operation: (
        revalidateAuthority: () => Promise<void>,
      ) => Promise<LearnedCapabilityRecordV2>,
    ) => Promise<LearnedCapabilityRecordV2>;
  };
}

export function resolveProjectLearnedAreaRoot(
  configHome: string,
  scope: { readonly tenantId: string; readonly projectId: string },
): string {
  return join(
    resolve(configHome),
    'learned',
    'projects',
    scopedHash('tenant', scope.tenantId),
    scopedHash('project', scope.projectId),
  );
}

export function createLearnedCapabilityScope(
  configHome: string,
  scope: { readonly tenantId: string; readonly projectId: string },
): LearnedCapabilityScope {
  return {
    configHomeHash: scopedHash('config-home', normalizePath(configHome)),
    tenantHash: scopedHash('tenant', scope.tenantId),
    projectHash: scopedHash('project', scope.projectId),
  };
}

export function validateDeclarativeSkillSpec(spec: DeclarativeSkillSpec): void {
  const fields = [
    spec.name,
    spec.description,
    spec.purpose,
    ...spec.triggers,
    ...spec.steps,
    ...spec.verification,
    ...spec.pitfalls,
  ];
  const structurallyValid = spec.name === slugifyLearnedCapabilityName(spec.name)
    && spec.name.length <= 64
    && spec.description.trim().length > 0
    && spec.description.length <= 1_024
    && spec.purpose.trim().length > 0
    && spec.triggers.length > 0
    && spec.steps.length > 0
    && spec.verification.length > 0
    && fields.every((field) => field.trim().length > 0 && !field.includes('\0'));
  if (!structurallyValid || fields.some((field) => UNSAFE_PATTERNS.some((pattern) => pattern.test(field)))) {
    throw new LearningCapabilityError(
      'invalid_record',
      'unsafe learned Skill specification was rejected',
    );
  }
  const rendered = renderDeclarativeSkillUnchecked(spec);
  if (Buffer.byteLength(rendered, 'utf8') > MAX_LEARNED_SKILL_BYTES) {
    throw new LearningCapabilityError(
      'invalid_record',
      'unsafe learned Skill specification exceeds the size limit',
    );
  }
}

export function renderDeclarativeSkill(spec: DeclarativeSkillSpec): string {
  validateDeclarativeSkillSpec(spec);
  return renderDeclarativeSkillUnchecked(spec);
}

function renderDeclarativeSkillUnchecked(spec: DeclarativeSkillSpec): string {
  return [
    '---',
    `name: ${spec.name}`,
    `description: ${JSON.stringify(spec.description.trim())}`,
    '---',
    '',
    '# Purpose',
    '',
    spec.purpose.trim(),
    '',
    '## Use when',
    '',
    ...spec.triggers.map((trigger) => `- ${oneLine(trigger)}`),
    '',
    '## Steps',
    '',
    ...spec.steps.map((step, index) => `${index + 1}. ${oneLine(step)}`),
    '',
    '## Verification',
    '',
    ...spec.verification.map((check) => `- ${oneLine(check)}`),
    '',
    '## Pitfalls',
    '',
    ...spec.pitfalls.map((pitfall) => `- ${oneLine(pitfall)}`),
    '',
  ].join('\n');
}

export async function stageLearnedSkillRevision(
  rootDir: string,
  capabilityId: string,
  spec: DeclarativeSkillSpec,
): Promise<StagedLearnedSkillArtifact> {
  assertSafeCapabilityId(capabilityId);
  const content = renderDeclarativeSkill(spec);
  const fingerprint = sha256(content);
  const revisionDir = join(rootDir, 'skills', capabilityId, 'revisions', fingerprint);
  const absolutePath = join(revisionDir, 'SKILL.md');
  await ensureOwnedDirectory(rootDir);
  await ensureOwnedDirectory(join(rootDir, 'skills'));
  await ensureOwnedDirectory(join(rootDir, 'skills', capabilityId));
  await ensureOwnedDirectory(join(rootDir, 'skills', capabilityId, 'revisions'));
  await ensureOwnedDirectory(revisionDir);
  try {
    const handle = await open(absolutePath, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isFileError(error, 'EEXIST')) throw error;
    await assertRegularFile(absolutePath);
    if (await readFile(absolutePath, 'utf8') !== content) {
      throw new LearningCapabilityError(
        'store_integrity_error',
        'content-addressed learned Skill revision does not match its fingerprint',
      );
    }
  }
  await assertRegularFile(absolutePath);
  return {
    kind: 'skill_markdown',
    relativePath: relative(rootDir, absolutePath).split(sep).join('/'),
    fingerprint,
    contentRevision: 1,
    absolutePath,
  };
}

export function createLearnedSkillRecord(
  input: CreateLearnedSkillRecordInput,
): LearnedCapabilityRecordV2 {
  assertSafeCapabilityId(input.capabilityId);
  assertArtifact(input.artifact);
  assertScope(input.scope);
  const now = input.now ?? new Date().toISOString();
  const previous = input.previous;
  return {
    schemaVersion: 2,
    capabilityId: input.capabilityId,
    displayName: input.displayName.trim(),
    slug: slugifyLearnedCapabilityName(input.artifact.relativePath.split('/').at(-4) ?? input.displayName),
    carrier: 'skill',
    lifecycle: 'testing',
    revision: (previous?.revision ?? 0) + 1,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    source: { kind: 'skill_learning_loop' },
    artifactPath: input.artifact.relativePath,
    scope: input.scope,
    artifact: withoutAbsolutePath(input.artifact),
    ...(previous === undefined
      ? {}
      : {
          previousGoodRevision: previous.lifecycle === 'active_learned'
            ? previous.artifact.contentRevision
            : previous.previousGoodRevision,
          previousGoodArtifact: previous.lifecycle === 'active_learned'
            ? previous.artifact
            : previous.previousGoodArtifact,
          previousLifecycle: previous.lifecycle,
        }),
    provenance: input.provenance,
    canary: {
      maxInvocations: 3,
      invocationCount: 0,
      verifiedSuccesses: 0,
      credibleNegatives: 0,
      invocations: [],
    },
  };
}

export async function commitLearnedSkillRevision(
  store: LearnedAreaStore,
  input: CommitLearnedSkillRevisionInput,
): Promise<LearnedCapabilityRecordV2> {
  validateDeclarativeSkillSpec(input.spec);
  const now = input.now ?? new Date().toISOString();
  const capabilityId = input.operation === 'patch'
    ? input.targetCapabilityId
    : learnedSkillCapabilityId(input.spec.name, input.scope);
  if (capabilityId === undefined) {
    throw new LearningCapabilityError('invalid_record', 'learned Skill patch target is missing');
  }
  const stagedArtifact = await stageLearnedSkillRevision(store.paths.root, capabilityId, input.spec);
  const commit = async (
    revalidateAuthority: () => Promise<void>,
  ): Promise<LearnedCapabilityRecordV2> => store.withOwnerMutation(async () => {
    await revalidateAuthority();
    const existing = await store.readCapability(capabilityId);
    if (existing !== undefined
      && isLearnedCapabilityRecordV2(existing)
      && existing.provenance.actionId === input.provenance.actionId) {
      return existing;
    }
    let previous: LearnedCapabilityRecordV2 | undefined;
    if (input.operation === 'patch') {
      if (existing === undefined || !isLearnedCapabilityRecordV2(existing)) {
        throw new LearningCapabilityError('capability_not_found', 'learned Skill patch target was not found');
      }
      if (existing.source.kind !== 'skill_learning_loop'
        || existing.artifact.contentRevision !== input.expectedRevision
        || existing.artifact.fingerprint !== input.expectedFingerprint) {
        throw new LearningCapabilityError(
          'invalid_record',
          'learned Skill patch expected revision or fingerprint changed',
        );
      }
      previous = existing;
    } else {
      const collision = (await store.listCapabilities()).find((record) => (
        record.slug === input.spec.name && record.capabilityId !== capabilityId
      ));
      if (existing !== undefined || collision !== undefined) {
        throw new LearningCapabilityError('invalid_record', 'learned Skill create target already exists');
      }
    }
    const artifact: LearnedCapabilityArtifact = {
      ...withoutAbsolutePath(stagedArtifact),
      contentRevision: previous === undefined
        ? 1
        : previous.artifact.contentRevision + 1,
    };
    const protectedName = (input.protectedSkillNames ?? []).includes(input.spec.name);
    const requestedLifecycle = input.disposition === 'project_canary' && !protectedName
      ? 'testing'
      : 'ready';
    const record = {
      ...createLearnedSkillRecord({
        capabilityId,
        displayName: input.spec.name,
        scope: input.scope,
        artifact,
        provenance: input.provenance,
        now,
        ...(previous === undefined ? {} : { previous }),
      }),
      slug: input.spec.name,
      lifecycle: requestedLifecycle,
      ...(protectedName
        ? { diagnostics: ['formal Skill name collision requires explicit user review'] }
        : {}),
    } satisfies LearnedCapabilityRecordV2;
    await revalidateAuthority();
    await store.writeCapability(record);
    await store.ensureCurrentEvent(record);
    return record;
  });
  return input.authority === undefined
    ? commit(async () => {})
    : input.authority.commit(commit);
}

export function isLearnedCapabilityRecordV2(
  record: LearnedCapabilityRecord,
): record is LearnedCapabilityRecordV2 {
  return record.schemaVersion === 2;
}

async function mutateLearnedSkill<T>(
  store: LearnedAreaStore,
  capabilityId: string,
  now: string,
  mutate: (
    record: LearnedCapabilityRecordV2,
  ) => {
    readonly record: LearnedCapabilityRecordV2;
    readonly result: T;
    readonly changed: boolean;
  },
): Promise<T> {
  return store.withOwnerMutation(async () => {
    const current = await store.readCapability(capabilityId);
    if (current === undefined || !isLearnedCapabilityRecordV2(current)) {
      throw new LearningCapabilityError('capability_not_found', 'learned Skill record was not found');
    }
    const outcome = mutate(current);
    if (!outcome.changed) return outcome.result;
    const next: LearnedCapabilityRecordV2 = {
      ...outcome.record,
      revision: current.revision + 1,
      updatedAt: now,
    };
    await store.writeCapability(next);
    await store.ensureCurrentEvent(next);
    return outcome.result === outcome.record ? next as T : outcome.result;
  });
}

function assertSafeCapabilityId(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new LearningCapabilityError('invalid_record', 'learned Skill capabilityId is unsafe');
  }
}

function assertScope(scope: LearnedCapabilityScope): void {
  if (![scope.configHomeHash, scope.tenantHash, scope.projectHash].every((value) => HASH_RE.test(value))) {
    throw new LearningCapabilityError('invalid_record', 'learned Skill project scope is invalid');
  }
}

function assertArtifact(artifact: LearnedCapabilityArtifact): void {
  if (artifact.kind !== 'skill_markdown'
    || !HASH_RE.test(artifact.fingerprint)
    || artifact.contentRevision < 1
    || artifact.relativePath.startsWith('/')
    || artifact.relativePath.includes('\\')
    || artifact.relativePath.split('/').some((part) => part === '..' || part === '.')) {
    throw new LearningCapabilityError('invalid_record', 'learned Skill artifact reference is invalid');
  }
}

function withoutAbsolutePath(artifact: LearnedCapabilityArtifact): LearnedCapabilityArtifact {
  return {
    kind: artifact.kind,
    relativePath: artifact.relativePath,
    fingerprint: artifact.fingerprint,
    contentRevision: artifact.contentRevision,
  };
}

function oneLine(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function learnedSkillCapabilityId(name: string, scope: LearnedCapabilityScope): string {
  return `lc_skill_${sha256([
    name,
    scope.configHomeHash,
    scope.tenantHash,
    scope.projectHash,
  ].join('\0')).slice(0, 24)}`;
}

function scopedHash(kind: string, value: string): string {
  return sha256(`${kind}\0${value}`);
}

function normalizePath(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function ensureOwnedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new LearningCapabilityError(
      'store_integrity_error',
      `learned Skill directory is not an owned regular directory: ${directory}`,
    );
  }
}

async function assertRegularFile(filePath: string): Promise<void> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new LearningCapabilityError(
      'store_integrity_error',
      `learned Skill artifact is not a regular file: ${filePath}`,
    );
  }
}

function isFileError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
