import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLearningCenterService } from './learning-center-service.js';
import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '../diagnostics.js';
import { createLearnedSkillActionDriver, importApprovedLearnedSkills } from './learned-skill-driver.js';
import {
  admitLearnedSkillBinding,
  commitLearnedSkillRevision,
  completeLearnedSkillOutcome,
  createLearnedCapabilityScope,
  invokeLearnedSkillCanary,
  quarantineLearnedSkillRevision,
  resolveProjectLearnedAreaRoot,
  type DeclarativeSkillSpec,
} from './learned-skill.js';
import { LearnedAreaStore } from './learned-area-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  readonly rootDir: string;
  readonly userSkillsRoot: string;
  readonly store: LearnedAreaStore;
}> {
  const root = await mkdtemp(join(tmpdir(), 'kodax-learned-driver-'));
  roots.push(root);
  const rootDir = join(root, 'learned-project');
  const store = new LearnedAreaStore(rootDir);
  await store.initialize();
  return { rootDir, userSkillsRoot: join(root, 'user-skills'), store };
}

function spec(step: string): DeclarativeSkillSpec {
  return {
    name: 'verify-release',
    description: 'Use when validating this project before a release.',
    purpose: 'Verify release state from reproducible evidence.',
    triggers: ['A release candidate needs verification.'],
    steps: [step],
    verification: ['Require a passing check artifact.'],
    pitfalls: ['Do not treat model self-report as verification.'],
  };
}

async function promotionFixture() {
  const area = await fixture();
  const created = await commitLearnedSkillRevision(area.store, {
    scope: createLearnedCapabilityScope(area.rootDir, {
      tenantId: 'tenant-a',
      projectId: 'project-a',
    }),
    spec: spec('Run the release test suite.'),
    disposition: 'ready',
    operation: 'create',
    provenance: {
      jobId: 'job-1',
      inputHash: 'a'.repeat(64),
      decisionId: 'decision-1',
      actionId: 'action-1',
    },
  });
  const service = createLearningCenterService({
    rootDir: area.rootDir,
    clientIdentity: 'user-a',
    actionDrivers: [createLearnedSkillActionDriver({
      learnedAreaRoot: area.rootDir,
      learnedAreaKind: 'project',
      userSkillsRoot: area.userSkillsRoot,
    })],
  });
  return { ...area, created, service };
}

describe('FEATURE_263 learned Skill action driver', () => {
  it('rolls the canonical record back to the exact previous immutable artifact', async () => {
    const area = await fixture();
    const initial = await commitLearnedSkillRevision(area.store, {
      scope: createLearnedCapabilityScope(area.rootDir, {
        tenantId: 'tenant-a',
        projectId: 'project-a',
      }),
      spec: spec('Run the release test suite.'),
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-1',
        inputHash: 'a'.repeat(64),
        decisionId: 'decision-1',
        actionId: 'action-1',
      },
    });
    const service = createLearningCenterService({
      rootDir: area.rootDir,
      clientIdentity: 'user-a',
      actionDrivers: [createLearnedSkillActionDriver({
        learnedAreaRoot: area.rootDir,
        learnedAreaKind: 'project',
        userSkillsRoot: area.userSkillsRoot,
      })],
    });
    await service.trust(initial.slug);
    const trusted = await service.get(initial.slug);
    const patched = await commitLearnedSkillRevision(area.store, {
      scope: initial.scope,
      spec: spec('Run tests and inspect the exact release diff.'),
      disposition: 'project_canary',
      operation: 'patch',
      targetCapabilityId: initial.capabilityId,
      expectedRevision: initial.artifact.contentRevision,
      expectedFingerprint: initial.artifact.fingerprint,
      provenance: {
        jobId: 'job-2',
        inputHash: 'b'.repeat(64),
        decisionId: 'decision-2',
        actionId: 'action-2',
      },
    });

    expect(patched.artifact.contentRevision).toBe(2);
    expect(patched.previousGoodArtifact).toEqual(trusted.artifact);
    await service.rollback(initial.slug);

    expect(await service.get(initial.slug)).toMatchObject({
      lifecycle: 'active_learned',
      lastAction: 'rollback',
      artifact: {
        contentRevision: 1,
        fingerprint: initial.artifact.fingerprint,
      },
      previousGoodArtifact: {
        contentRevision: 1,
        fingerprint: initial.artifact.fingerprint,
      },
    });

    await service.rollback(initial.slug);
    expect(await service.get(initial.slug)).toMatchObject({
      lifecycle: 'active_learned',
      lastAction: 'rollback',
      artifact: {
        contentRevision: 1,
        fingerprint: initial.artifact.fingerprint,
      },
      previousGoodArtifact: {
        contentRevision: 1,
        fingerprint: initial.artifact.fingerprint,
      },
    });
  });

  it('preserves the real previous-good artifact across canary activation and explicit trust', async () => {
    const area = await fixture();
    const scope = createLearnedCapabilityScope(area.rootDir, {
      tenantId: 'tenant-a',
      projectId: 'project-a',
    });
    const initial = await commitLearnedSkillRevision(area.store, {
      scope,
      spec: spec('Run the release test suite.'),
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-1',
        inputHash: 'a'.repeat(64),
        decisionId: 'decision-1',
        actionId: 'action-1',
      },
    });
    const service = createLearningCenterService({
      rootDir: area.rootDir,
      clientIdentity: 'user-a',
      actionDrivers: [createLearnedSkillActionDriver({
        learnedAreaRoot: area.rootDir,
        learnedAreaKind: 'project',
        userSkillsRoot: area.userSkillsRoot,
      })],
    });
    await service.trust(initial.capabilityId);

    const canary = await commitLearnedSkillRevision(area.store, {
      scope,
      spec: spec('Run tests and inspect the exact release diff.'),
      disposition: 'project_canary',
      operation: 'patch',
      targetCapabilityId: initial.capabilityId,
      expectedRevision: initial.artifact.contentRevision,
      expectedFingerprint: initial.artifact.fingerprint,
      provenance: {
        jobId: 'job-2',
        inputHash: 'b'.repeat(64),
        decisionId: 'decision-2',
        actionId: 'action-2',
      },
    });
    await admitLearnedSkillBinding(area.store, initial.capabilityId, {
      bindingId: 'binding-a',
      ownerSessionRef: 'session-a',
    });
    await invokeLearnedSkillCanary(area.store, initial.capabilityId, {
      bindingId: 'binding-a',
      invocationId: 'invocation-a',
    });
    await completeLearnedSkillOutcome(area.store, initial.capabilityId, {
      invocationId: 'invocation-a',
      outcome: 'verified_success',
      evidenceRefs: ['check:passed'],
    });
    expect(await area.store.readCapability(initial.capabilityId)).toMatchObject({
      previousGoodArtifact: { fingerprint: initial.artifact.fingerprint },
    });
    await quarantineLearnedSkillRevision(area.store, initial.capabilityId, {
      expectedRevision: canary.artifact.contentRevision,
      expectedFingerprint: canary.artifact.fingerprint,
      reason: 'verified regression',
    });
    await service.rollback(initial.capabilityId);
    expect(await service.get(initial.capabilityId)).toMatchObject({
      artifact: { fingerprint: initial.artifact.fingerprint },
    });

    const trustedPatch = await commitLearnedSkillRevision(area.store, {
      scope,
      spec: spec('Run tests, inspect the diff, and validate the package.'),
      disposition: 'project_canary',
      operation: 'patch',
      targetCapabilityId: initial.capabilityId,
      expectedRevision: initial.artifact.contentRevision,
      expectedFingerprint: initial.artifact.fingerprint,
      provenance: {
        jobId: 'job-3',
        inputHash: 'c'.repeat(64),
        decisionId: 'decision-3',
        actionId: 'action-3',
      },
    });
    await service.trust(initial.capabilityId);
    expect(await area.store.readCapability(initial.capabilityId)).toMatchObject({
      previousGoodArtifact: { fingerprint: initial.artifact.fingerprint },
    });
    await quarantineLearnedSkillRevision(area.store, initial.capabilityId, {
      expectedRevision: trustedPatch.artifact.contentRevision,
      expectedFingerprint: trustedPatch.artifact.fingerprint,
      reason: 'explicitly trusted revision regressed',
    });
    await service.rollback(initial.capabilityId);
    expect(await service.get(initial.capabilityId)).toMatchObject({
      artifact: { fingerprint: initial.artifact.fingerprint },
    });
  });

  it('promotes only the exact fingerprint to a non-overwriting user Skill', async () => {
    const area = await promotionFixture();
    const destination = join(area.userSkillsRoot, area.created.slug, 'SKILL.md');

    await expect(area.service.promote(
      area.created.slug,
      'project' as unknown as 'user',
    )).rejects.toMatchObject({ code: 'unsupported_action' });
    expect(await area.service.get(area.created.slug)).toMatchObject({ lifecycle: 'ready' });
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });

    await area.service.promote(area.created.slug, 'user');
    const promoted = await area.service.get(area.created.slug);
    expect(promoted).toMatchObject({ lifecycle: 'promoted_user' });
    expect(await readFile(destination, 'utf8'))
      .toContain('Run the release test suite.');
    expect(await readdir(dirname(destination))).toEqual(['SKILL.md']);

    await area.service.promote(area.created.slug, 'user');
    expect(await area.service.get(area.created.slug)).toEqual(promoted);
  });

  it('rejects a no-op from an unrelated action driver', async () => {
    const area = await promotionFixture();
    const service = createLearningCenterService({
      rootDir: area.rootDir,
      clientIdentity: 'user-a',
      actionDrivers: [{
        carrier: 'skill',
        actions: ['review'],
        execute: async (_action, capability) => capability,
      }],
    });

    await expect(service.review(area.created.capabilityId))
      .rejects.toMatchObject({ code: 'invalid_record' });
    expect(await service.get(area.created.capabilityId)).toMatchObject({ lifecycle: 'ready' });
  });

  it('refuses a different formal Skill without changing the learned record', async () => {
    const area = await promotionFixture();
    const destination = join(area.userSkillsRoot, area.created.slug, 'SKILL.md');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, 'human-owned formal Skill', 'utf8');

    await expect(area.service.promote(area.created.slug, 'user'))
      .rejects.toMatchObject({ code: 'action_failed' });
    expect(await readFile(destination, 'utf8')).toBe('human-owned formal Skill');
    expect(await area.service.get(area.created.slug)).toMatchObject({ lifecycle: 'ready' });
  });

  it('refuses a fingerprint-tampered learned artifact', async () => {
    const area = await promotionFixture();
    const source = join(area.rootDir, ...area.created.artifact.relativePath.split('/'));
    await writeFile(source, 'tampered learned Skill', 'utf8');

    await expect(area.service.promote(area.created.slug, 'user'))
      .rejects.toMatchObject({ code: 'store_integrity_error' });
    expect(await area.service.get(area.created.slug)).toMatchObject({ lifecycle: 'ready' });
    await expect(access(join(area.userSkillsRoot, area.created.slug, 'SKILL.md')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a learned artifact reached through a symlinked directory', async () => {
    const area = await promotionFixture();
    const source = join(area.rootDir, ...area.created.artifact.relativePath.split('/'));
    const sourceDir = dirname(source);
    const outsideDir = join(dirname(area.rootDir), 'outside-learned-revision');
    await rename(sourceDir, outsideDir);
    await symlink(outsideDir, sourceDir, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(area.service.promote(area.created.slug, 'user'))
      .rejects.toMatchObject({ code: 'store_integrity_error' });
    expect(await area.service.get(area.created.slug)).toMatchObject({ lifecycle: 'ready' });
  });

  it('refuses a formal Skill directory that is a symlink or junction', async () => {
    const area = await promotionFixture();
    const outsideDir = join(dirname(area.rootDir), 'outside-formal-skill');
    await mkdir(area.userSkillsRoot, { recursive: true });
    await mkdir(outsideDir);
    await symlink(
      outsideDir,
      join(area.userSkillsRoot, area.created.slug),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(area.service.promote(area.created.slug, 'user'))
      .rejects.toMatchObject({ code: 'store_integrity_error' });
    await expect(access(join(outsideDir, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await area.service.get(area.created.slug)).toMatchObject({ lifecycle: 'ready' });
  });

  it('refuses a formal user Skill root that is a symlink or junction', async () => {
    const area = await promotionFixture();
    const outsideDir = join(dirname(area.rootDir), 'outside-formal-root');
    await mkdir(outsideDir);
    await symlink(
      outsideDir,
      area.userSkillsRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(area.service.promote(area.created.slug, 'user'))
      .rejects.toMatchObject({ code: 'store_integrity_error' });
    await expect(access(join(outsideDir, area.created.slug, 'SKILL.md')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await area.service.get(area.created.slug)).toMatchObject({ lifecycle: 'ready' });
  });

  it.skipIf(process.platform === 'win32')(
    'refuses an existing formal Skill target that is a symlink',
    async () => {
    const area = await promotionFixture();
    const source = join(area.rootDir, ...area.created.artifact.relativePath.split('/'));
    const destination = join(area.userSkillsRoot, area.created.slug, 'SKILL.md');
    const outsideFile = join(dirname(area.rootDir), 'outside-formal-skill.md');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(outsideFile, await readFile(source, 'utf8'), 'utf8');
    await symlink(outsideFile, destination, 'file');

    await expect(area.service.promote(area.created.slug, 'user'))
      .rejects.toMatchObject({ code: 'store_integrity_error' });
    expect(await area.service.get(area.created.slug)).toMatchObject({ lifecycle: 'ready' });
    },
  );

  it('exposes project records through the global Learning Center owner', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-global-learning-'));
    roots.push(configHome);
    const globalRoot = join(configHome, 'learned');
    const projectRoot = resolveProjectLearnedAreaRoot(configHome, {
      tenantId: 'tenant-a',
      projectId: 'project-a',
    });
    const projectStore = new LearnedAreaStore(projectRoot);
    await projectStore.initialize();
    const created = await commitLearnedSkillRevision(projectStore, {
      scope: createLearnedCapabilityScope(configHome, {
        tenantId: 'tenant-a',
        projectId: 'project-a',
      }),
      spec: spec('Run the release test suite.'),
      disposition: 'ready',
      operation: 'create',
      provenance: {
        jobId: 'job-global',
        inputHash: 'c'.repeat(64),
        decisionId: 'decision-global',
        actionId: 'action-global',
      },
    });
    const service = createLearningCenterService({
      rootDir: globalRoot,
      clientIdentity: 'user-a',
      actionDrivers: [createLearnedSkillActionDriver({
        learnedAreaRoot: globalRoot,
        learnedAreaKind: 'global',
        userSkillsRoot: join(configHome, 'skills'),
      })],
    });
    await service.initialize();

    expect((await service.list()).items).toContainEqual(expect.objectContaining({
      capabilityId: created.capabilityId,
      slug: created.slug,
    }));
    await expect(service.disable(created.slug, {
      authority: 'explicit_user',
      expectedRevision: created.revision + 1,
      expectedFingerprint: created.artifact.fingerprint,
    })).rejects.toMatchObject({
      // Its own code, so the daemon can report a capability that changed as a conflict to read again.
      code: 'revision_conflict',
      message: expect.stringMatching(/expected revision or fingerprint changed/i),
    });
    await service.promote(created.slug, 'user');
    expect(await projectStore.readCapability(created.capabilityId)).toMatchObject({
      lifecycle: 'promoted_user',
    });
  });

  it('requires capabilityId when the same slug exists in multiple projects', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-global-ambiguous-learning-'));
    roots.push(configHome);
    const globalRoot = join(configHome, 'learned');
    const createProjectRecord = async (projectId: string, actionId: string) => {
      const projectRoot = resolveProjectLearnedAreaRoot(configHome, {
        tenantId: 'tenant-a',
        projectId,
      });
      const projectStore = new LearnedAreaStore(projectRoot);
      await projectStore.initialize();
      return {
        projectStore,
        record: await commitLearnedSkillRevision(projectStore, {
          scope: createLearnedCapabilityScope(configHome, {
            tenantId: 'tenant-a',
            projectId,
          }),
          spec: spec('Run the release test suite.'),
          disposition: 'ready',
          operation: 'create',
          provenance: {
            jobId: `job-${projectId}`,
            inputHash: actionId.repeat(64).slice(0, 64),
            decisionId: `decision-${projectId}`,
            actionId,
          },
        }),
      };
    };
    const first = await createProjectRecord('project-a', 'a');
    const second = await createProjectRecord('project-b', 'b');
    const service = createLearningCenterService({
      rootDir: globalRoot,
      clientIdentity: 'user-a',
      actionDrivers: [createLearnedSkillActionDriver({
        learnedAreaRoot: globalRoot,
        learnedAreaKind: 'global',
        userSkillsRoot: join(configHome, 'skills'),
      })],
    });
    await service.initialize();

    await expect(service.get('verify-release')).rejects.toMatchObject({
      code: 'ambiguous_name',
    });
    expect((await service.get(second.record.capabilityId)).capabilityId)
      .toBe(second.record.capabilityId);
    await service.disable(second.record.capabilityId);
    expect(await second.projectStore.readCapability(second.record.capabilityId))
      .toMatchObject({ lifecycle: 'archived' });
    expect(await first.projectStore.readCapability(first.record.capabilityId))
      .toMatchObject({ lifecycle: 'ready' });
  });
});

describe('importApprovedLearnedSkills', () => {
  async function projectRecord(
    configHome: string,
    projectId: string,
    step: string,
    approve: boolean,
  ) {
    const projectRoot = resolveProjectLearnedAreaRoot(configHome, { tenantId: 'tenant-a', projectId });
    const store = new LearnedAreaStore(projectRoot);
    await store.initialize();
    const record = await commitLearnedSkillRevision(store, {
      scope: createLearnedCapabilityScope(configHome, { tenantId: 'tenant-a', projectId }),
      spec: approve ? spec(step) : { ...spec(step), name: `draft-${projectId}` },
      disposition: 'ready',
      operation: 'create',
      provenance: {
        jobId: `job-${projectId}`,
        inputHash: 'c'.repeat(64),
        decisionId: `decision-${projectId}`,
        actionId: `action-${projectId}`,
      },
    });
    if (approve) {
      await createLearningCenterService({
        rootDir: projectRoot,
        clientIdentity: 'user-a',
        actionDrivers: [createLearnedSkillActionDriver({
          learnedAreaRoot: projectRoot,
          learnedAreaKind: 'project',
          userSkillsRoot: join(configHome, 'unused-skills'),
        })],
      }).trust(record.capabilityId);
    }
    return { store, record };
  }

  it('copies approved Skills once, never overwrites a user Skill and leaves learned records alone', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-learned-import-'));
    roots.push(configHome);
    const first = await projectRecord(configHome, 'project-a', 'Run the release test suite.', true);
    await projectRecord(configHome, 'project-b', 'Run only the smoke tests.', true);
    await projectRecord(configHome, 'project-c', 'Not approved yet.', false);
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    try {
      await importApprovedLearnedSkills(configHome);
      const skillsRoot = join(configHome, 'skills');
      const copied = await readFile(join(skillsRoot, 'verify-release', 'SKILL.md'), 'utf8');
      expect(copied.includes('Run the release test suite.') !== copied.includes('Run only the smoke tests.')).toBe(true);
      expect((await readdir(skillsRoot)).sort()).toEqual(['.learned-skills-imported.json', 'verify-release']);
      expect(diagnostics.filter((item) => item.level === 'warn')).toHaveLength(1);
      expect(await first.store.readCapability(first.record.capabilityId)).toMatchObject({ lifecycle: 'active_learned' });

      await rm(join(skillsRoot, 'verify-release'), { recursive: true, force: true });
      await importApprovedLearnedSkills(configHome);
      await expect(access(join(skillsRoot, 'verify-release'))).rejects.toThrow();
    } finally {
      restore();
    }
  });
});
