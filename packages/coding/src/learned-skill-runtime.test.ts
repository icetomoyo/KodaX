import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import {
  LearnedAreaStore,
  SkillRegistry,
  commitLearnedSkillRevision,
  createLearnedCapabilityScope,
  resolveProjectLearnedAreaRoot,
} from '@kodax-ai/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareCodingLearnedSkillBinding } from './learned-skill-runtime.js';

const roots: string[] = [];
const learnedSpec = {
  name: 'verify-release',
  description: 'Use when validating this project before a release.',
  purpose: 'Verify release state from reproducible evidence.',
  triggers: ['A release candidate needs verification.'],
  steps: ['Run the release test suite.'],
  verification: ['Require a passing check artifact.'],
  pitfalls: ['Do not treat self-report as verification.'],
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  })));
});

describe('FEATURE_263 coding root learned Skill binding', () => {
  it('discovers formal project Skills at gitRoot while executing from a subdirectory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-skill-subdirectory-'));
    roots.push(root);
    const configHome = join(root, 'home');
    const projectRoot = join(root, 'project');
    const cwd = join(projectRoot, 'src');
    const skillDir = join(projectRoot, '.kodax', 'skills', 'root-skill');
    await mkdir(cwd, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: root-skill\ndescription: Inspect project code\n---\nRoot instructions\n');
    const binding = await prepareCodingLearnedSkillBinding({ provider: 'test',
      context: { configHome, gitRoot: projectRoot, executionCwd: cwd } }, {
      configHome, tenantId: 'tenant', projectId: 'project', sessionId: 'session',
    }, 'session');
    try {
      expect(binding?.context.skillsPrompt).toContain('root-skill');
      expect((await binding?.context.skillRegistry?.loadFull('root-skill'))?.content).toContain('Root instructions');
    } finally { await binding?.release(); }
  });
  it('releases a canary admitted in one root when a later root fails to initialize', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-coding-learned-partial-'));
    roots.push(root);
    const configHome = join(root, '.kodax');
    const projectRoot = join(root, 'project');
    await mkdir(projectRoot, { recursive: true });
    const tenantId = `local:${configHome}`;
    const remoteProjectId = 'remote:github.com/kodax/partial';
    const localProjectId = `local:${path.resolve(projectRoot).toLowerCase()}`;
    const remoteStore = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, {
      tenantId,
      projectId: remoteProjectId,
    }));
    const localStore = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, {
      tenantId,
      projectId: localProjectId,
    }));
    await Promise.all([remoteStore.initialize(), localStore.initialize()]);
    const record = await commitLearnedSkillRevision(remoteStore, {
      scope: createLearnedCapabilityScope(configHome, { tenantId, projectId: remoteProjectId }),
      spec: learnedSpec,
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-partial',
        inputHash: 'd'.repeat(64),
        decisionId: 'decision-partial',
        actionId: 'action-partial',
      },
    });
    const originalList = LearnedAreaStore.prototype.listCapabilities;
    const list = vi.spyOn(LearnedAreaStore.prototype, 'listCapabilities')
      .mockImplementation(async function (this: LearnedAreaStore) {
        if (this.paths.root === localStore.paths.root) throw new Error('local root unavailable');
        return originalList.call(this);
      });
    try {
      await expect(prepareCodingLearnedSkillBinding({
        provider: 'test',
        context: { configHome, executionCwd: projectRoot },
      }, {
        configHome,
        tenantId,
        agentId: 'coding-agent',
        projectId: remoteProjectId,
        sessionId: 'session-partial',
      }, 'session-partial')).resolves.toBeUndefined();
    } finally {
      list.mockRestore();
    }
    expect((await remoteStore.readCapability(record.capabilityId))?.canary)
      .not.toHaveProperty('binding');
  });

  it.each([
    'remote:github.com/kodax/repo',
    `remote-hash:${'f'.repeat(64)}`,
  ])('binds a local-root canary when the active identity is %s', async (remoteProjectId) => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-coding-learned-dual-root-'));
    roots.push(root);
    const configHome = join(root, '.kodax');
    const projectRoot = join(root, 'project');
    await mkdir(projectRoot, { recursive: true });
    const tenantId = `local:${configHome}`;
    const localProjectId = `local:${path.resolve(projectRoot).toLowerCase()}`;
    const localStore = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, {
      tenantId,
      projectId: localProjectId,
    }));
    await localStore.initialize();
    const record = await commitLearnedSkillRevision(localStore, {
      scope: createLearnedCapabilityScope(configHome, { tenantId, projectId: localProjectId }),
      spec: learnedSpec,
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-dual-root',
        inputHash: 'c'.repeat(64),
        decisionId: 'decision-dual-root',
        actionId: 'action-dual-root',
      },
    });
    const staleRemoteStore = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, {
      tenantId,
      projectId: remoteProjectId,
    }));
    await staleRemoteStore.initialize();
    // A misplaced local-scope duplicate in the remote physical root must not
    // steal discovery or lifecycle ownership from the paired local root.
    await staleRemoteStore.writeCapability(record);
    const identity = {
      configHome,
      tenantId,
      agentId: 'coding-agent',
      projectId: remoteProjectId,
      sessionId: 'session-dual-root',
    } as const;

    const binding = await prepareCodingLearnedSkillBinding({
      provider: 'test',
      context: { configHome, executionCwd: projectRoot },
    }, identity, identity.sessionId);

    expect(binding?.context.skillRegistry?.get('verify-release')).toMatchObject({ source: 'learned' });
    await expect(binding?.context.admitLearnedSkillInvocation?.({
      sessionId: 'child-dual-root',
      capabilityId: record.capabilityId,
      revision: record.artifact.contentRevision,
      fingerprint: record.artifact.fingerprint,
    })).resolves.toMatchObject({ invocationId: expect.any(String) });
    await binding?.context.completeLearnedSkillOutcomes?.({
      sessionId: 'child-dual-root',
      outcome: 'verified_success',
      evidenceRefs: ['artifact:dual-root'],
    });
    await binding?.release();
    await expect(localStore.readCapability(record.capabilityId)).resolves.toMatchObject({
      canary: { verifiedSuccesses: 1 },
    });
    await expect(staleRemoteStore.readCapability(record.capabilityId)).resolves.toMatchObject({
      lifecycle: 'testing',
      canary: { verifiedSuccesses: 0 },
    });
  });

  it('fails closed without blocking the foreground when the Learned Area contains invalid JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-coding-learned-invalid-'));
    roots.push(root);
    const configHome = join(root, '.kodax');
    const projectRoot = join(root, 'project');
    const identity = {
      configHome,
      tenantId: `local:${configHome}`,
      agentId: 'coding-agent',
      projectId: `local:${projectRoot}`,
      sessionId: 'session-invalid',
    } as const;
    const store = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, identity));
    await store.initialize();
    await writeFile(join(store.paths.capabilities, 'broken.json'), '{not-json', 'utf8');

    await expect(prepareCodingLearnedSkillBinding({
      provider: 'test',
      context: { configHome, executionCwd: projectRoot },
    }, identity, 'session-invalid')).resolves.toBeUndefined();
  });

  it('fails closed without blocking the foreground when legacy migration cannot read its records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-coding-learned-migration-'));
    roots.push(root);
    const configHome = join(root, '.kodax');
    const projectRoot = join(root, 'project');
    const identity = {
      configHome,
      tenantId: `local:${configHome}`,
      agentId: 'coding-agent',
      projectId: `local:${projectRoot}`,
      sessionId: 'session-migration',
    } as const;
    const legacyCapabilities = join(configHome, 'learned', 'capabilities');
    await mkdir(legacyCapabilities, { recursive: true });
    await writeFile(join(legacyCapabilities, 'broken.json'), '{not-json', 'utf8');

    await expect(prepareCodingLearnedSkillBinding({
      provider: 'test',
      context: { configHome, executionCwd: projectRoot },
    }, identity, 'session-migration')).resolves.toBeUndefined();
  });

  it('discovers the project canary, admits exact invocation, and releases the root reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-coding-learned-'));
    roots.push(root);
    const configHome = join(root, '.kodax');
    const projectRoot = join(root, 'project');
    const identity = {
      configHome,
      tenantId: `local:${configHome}`,
      agentId: 'coding-agent',
      projectId: `local:${projectRoot}`,
      sessionId: 'session-a',
    } as const;
    const store = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, identity));
    await store.initialize();
    const record = await commitLearnedSkillRevision(store, {
      scope: createLearnedCapabilityScope(configHome, identity),
      spec: {
        name: 'verify-release',
        description: 'Use when validating this project before a release.',
        purpose: 'Verify release state from reproducible evidence.',
        triggers: ['A release candidate needs verification.'],
        steps: ['Run the release test suite.'],
        verification: ['Require a passing check artifact.'],
        pitfalls: ['Do not treat self-report as verification.'],
      },
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-1',
        inputHash: 'a'.repeat(64),
        decisionId: 'decision-1',
        actionId: 'action-1',
      },
    });
    const first = await prepareCodingLearnedSkillBinding({
      provider: 'test',
      context: { configHome, executionCwd: projectRoot },
    }, identity, 'session-a');
    const second = await prepareCodingLearnedSkillBinding({
      provider: 'test',
      context: { configHome, executionCwd: projectRoot },
    }, { ...identity, sessionId: 'session-b' }, 'session-b');

    expect(first?.context.skillRegistry?.get('verify-release')).toMatchObject({
      source: 'learned',
    });
    expect(first?.context.learnedSkillBindingId).toMatch(/^root_/);
    expect(second?.context.skillRegistry?.has('verify-release')).toBe(false);
    await first?.context.admitLearnedSkillInvocation?.({
      sessionId: 'child-session',
      capabilityId: record.capabilityId,
      revision: record.artifact.contentRevision,
      fingerprint: record.artifact.fingerprint,
    });
    await first?.context.completeLearnedSkillOutcomes?.({
      sessionId: 'child-session',
      outcome: 'verified_success',
      evidenceRefs: ['artifact:check-1'],
    });
    await first?.release();
    await second?.release();

    const completed = await store.readCapability(record.capabilityId);
    expect(completed).toMatchObject({
      lifecycle: 'testing',
      canary: { verifiedSuccesses: 1 },
    });
    expect(completed?.schemaVersion === 2 && 'binding' in completed.canary).toBe(false);
  });

  it('adds learned Skills to a Runtime-pinned formal registry after a managed workspace is known', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-coding-learned-overlay-'));
    roots.push(root);
    const configHome = join(root, '.kodax');
    const projectRoot = join(root, 'managed-project');
    const identity = {
      configHome,
      tenantId: `local:${configHome}`,
      agentId: 'runtime-agent',
      projectId: `local:${projectRoot}`,
      sessionId: 'session-managed',
    } as const;
    const store = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, identity));
    await store.initialize();
    await commitLearnedSkillRevision(store, {
      scope: createLearnedCapabilityScope(configHome, identity),
      spec: {
        name: 'verify-release',
        description: 'Use when validating this project before a release.',
        purpose: 'Verify release state from reproducible evidence.',
        triggers: ['A release candidate needs verification.'],
        steps: ['Run the release test suite.'],
        verification: ['Require a passing check artifact.'],
        pitfalls: ['Do not treat self-report as verification.'],
      },
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-managed',
        inputHash: 'b'.repeat(64),
        decisionId: 'decision-managed',
        actionId: 'action-managed',
      },
    });
    const formalRoot = join(root, 'formal-skills');
    await mkdir(join(formalRoot, 'formal-review'), { recursive: true });
    await writeFile(join(formalRoot, 'formal-review', 'SKILL.md'), [
      '---',
      'name: formal-review',
      'description: Review formal release policy.',
      '---',
      '',
      'Follow the formal policy.',
    ].join('\n'), 'utf8');
    const formalRegistry = new SkillRegistry(projectRoot, {
      projectPaths: [formalRoot],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(root, 'no-builtin-skills'),
    });
    await formalRegistry.discover();
    const hiddenFormalRoot = join(projectRoot, '.kodax', 'skills', 'hidden-formal');
    await mkdir(hiddenFormalRoot, { recursive: true });
    await writeFile(join(hiddenFormalRoot, 'SKILL.md'), [
      '---',
      'name: hidden-formal',
      'description: Formal Skill excluded from the pinned run selection.',
      '---',
      '',
      'Remain protected even when not selected for this run.',
    ].join('\n'), 'utf8');

    const binding = await prepareCodingLearnedSkillBinding({
      provider: 'test',
      context: {
        configHome,
        executionCwd: projectRoot,
        skillRegistry: formalRegistry,
        skillsPrompt: 'FORMAL SKILL CONTRACT',
      },
    }, identity, 'session-managed');

    expect(binding?.context.skillRegistry?.has('formal-review')).toBe(true);
    expect(binding?.context.skillRegistry?.get('verify-release')).toMatchObject({
      source: 'learned',
    });
    expect(binding?.context.skillsPrompt).toContain('FORMAL SKILL CONTRACT');
    expect(binding?.context.skillsPrompt).toContain('verify-release');
    expect(binding?.context.protectedFormalSkillNames).toEqual(
      expect.arrayContaining(['formal-review', 'hidden-formal']),
    );
    await binding?.release();
  });
});
