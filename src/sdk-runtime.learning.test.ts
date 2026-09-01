import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LearnedAreaStore,
  commitLearnedSkillRevision,
  createLearnedCapabilityScope,
  createLearningCenterService,
  resolveProjectLearnedAreaRoot,
} from '@kodax-ai/agent';
import type { RuntimeLearningService } from '@kodax-ai/kodax/runtime';
import { KODAX_VERSION } from '@kodax-ai/repl';
import type { RuntimeDaemonClientTransport } from './runtime-daemon/client.js';
import { bindRuntimeLearningClient, createRuntimeLearningOwner } from './runtime-learning.js';
import { createKodaXRuntime } from './sdk-runtime.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function seedReadyCapability(homeDir: string): Promise<void> {
  const service = createLearningCenterService({
    rootDir: join(homeDir, '.kodax', 'learned'),
    clientIdentity: 'seed',
  });
  await service.record({
    schemaVersion: 1,
    capabilityId: 'lc_runtime_test',
    displayName: 'Runtime test Skill',
    slug: 'runtime-test-skill',
    carrier: 'skill',
    lifecycle: 'ready',
    revision: 1,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    source: { kind: 'learning_controller' },
  });
}

async function seedPromotableCapability(homeDir: string): Promise<{
  readonly capabilityId: string;
  readonly slug: string;
  readonly contentNeedle: string;
}> {
  const configHome = join(homeDir, '.kodax');
  const identity = { tenantId: 'tenant-a', projectId: 'project-a' };
  const projectRoot = resolveProjectLearnedAreaRoot(configHome, identity);
  const store = new LearnedAreaStore(projectRoot);
  await store.initialize();
  const contentNeedle = 'Run the exact release verification suite.';
  const record = await commitLearnedSkillRevision(store, {
    scope: createLearnedCapabilityScope(projectRoot, identity),
    spec: {
      name: 'runtime-promote-skill',
      description: 'Use when verifying a release through the Runtime SDK.',
      purpose: 'Verify one release from reproducible evidence.',
      triggers: ['A release candidate needs verification.'],
      steps: [contentNeedle],
      verification: ['Require a passing check artifact.'],
      pitfalls: ['Do not treat model self-report as verification.'],
    },
    disposition: 'ready',
    operation: 'create',
    provenance: {
      jobId: 'job-runtime-promote',
      inputHash: 'a'.repeat(64),
      decisionId: 'decision-runtime-promote',
      actionId: 'action-runtime-promote',
    },
  });
  return {
    capabilityId: record.capabilityId,
    slug: record.slug,
    contentNeedle,
  };
}

describe('runtime.learning inline facade', () => {
  it('defers storage initialization until the learning facade is used', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-runtime-learning-lazy-'));
    tempDirs.push(homeDir);
    const rootDir = join(homeDir, '.kodax', 'learned');

    createRuntimeLearningOwner({
      rootDir,
      defaultClientIdentity: 'unused-client',
    });

    await expect(access(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not retain one facade per transient daemon principal', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-runtime-learning-facades-'));
    tempDirs.push(homeDir);
    const owner = createRuntimeLearningOwner({
      rootDir: join(homeDir, '.kodax', 'learned'),
      defaultClientIdentity: 'default-client',
    });

    const first = bindRuntimeLearningClient(owner, 'transient-principal');
    const second = bindRuntimeLearningClient(owner, 'transient-principal');

    expect(second).not.toBe(first);
    await first.getSnapshot();
    await second.getSnapshot();
  });

  it('accepts capabilityId as the exact target for public user actions', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-runtime-learning-id-'));
    tempDirs.push(homeDir);
    await seedReadyCapability(homeDir);
    const owner = createRuntimeLearningOwner({
      rootDir: join(homeDir, '.kodax', 'learned'),
      defaultClientIdentity: 'default-client',
    });

    expect((await owner.get('lc_runtime_test')).slug).toBe('runtime-test-skill');
    await owner.disable('lc_runtime_test');
    expect(await owner.get('lc_runtime_test')).toMatchObject({
      lifecycle: 'archived',
    });
  });

  it('cancels a lazy subscription before initialization installs an active iterator', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-runtime-learning-cancel-'));
    tempDirs.push(homeDir);
    const owner = createRuntimeLearningOwner({
      rootDir: join(homeDir, '.kodax', 'learned'),
      defaultClientIdentity: 'default-client',
    });
    const client = bindRuntimeLearningClient(owner, 'disconnecting-principal');
    const iterator = client.subscribe()[Symbol.asyncIterator]();

    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('persists a stable client cursor independently from other clients', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-runtime-learning-'));
    tempDirs.push(homeDir);
    await seedReadyCapability(homeDir);

    const first = await createKodaXRuntime({
      homeDir,
      clientInfo: { name: 'test', instanceId: 'stable-client' },
    });
    expect(first.capabilities?.learningCenter).toEqual({ version: 1 });
    expect((await first.learning.getSnapshot()).ready).toBe(1);
    await first.learning.acknowledge('runtime-test-skill');
    await first.close();

    const restarted = await createKodaXRuntime({
      homeDir,
      clientInfo: { name: 'test', instanceId: 'stable-client' },
    });
    const other = await createKodaXRuntime({
      homeDir,
      clientInfo: { name: 'test', instanceId: 'other-client' },
    });
    expect((await restarted.learning.getSnapshot()).ready).toBe(0);
    expect((await other.learning.getSnapshot()).ready).toBe(1);
    await restarted.close();
    await other.close();
  });

  it('queries ready capabilities through the public Runtime learning interface', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-runtime-learning-list-'));
    tempDirs.push(homeDir);
    await seedReadyCapability(homeDir);
    const runtime = await createKodaXRuntime({ homeDir });
    try {
      const publicLearning: RuntimeLearningService = runtime.learning;
      const page = await publicLearning.list({ lifecycle: 'ready', limit: 20 });

      expect(page.items).toEqual([
        expect.objectContaining({
          capabilityId: 'lc_runtime_test',
          lifecycle: 'ready',
          slug: 'runtime-test-skill',
        }),
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('persists notification state before a Runtime Worker hard stop', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-worker-learning-'));
    tempDirs.push(homeDir);
    await seedReadyCapability(homeDir);

    const worker = await createKodaXRuntime({
      homeDir,
      isolation: 'worker',
      clientInfo: { name: 'test', instanceId: 'worker-client' },
    });
    expect(worker.identity.isolation).toBe('worker');
    expect((await worker.learning.getSnapshot()).ready).toBe(1);
    await worker.learning.acknowledge('runtime-test-skill');
    await worker.close();

    const restarted = await createKodaXRuntime({
      homeDir,
      isolation: 'worker',
      clientInfo: { name: 'test', instanceId: 'worker-client' },
    });
    expect((await restarted.learning.getSnapshot()).ready).toBe(0);
    await restarted.close();
  });

  it.each(['inline', 'worker'] as const)(
    'promotes the exact learned Skill through the public %s Runtime learning facade',
    async (isolation) => {
      const homeDir = await mkdtemp(join(tmpdir(), `kodax-${isolation}-learning-promote-`));
      tempDirs.push(homeDir);
      const seeded = await seedPromotableCapability(homeDir);
      const runtime = await createKodaXRuntime({ homeDir, isolation });
      const publicLearning: RuntimeLearningService = runtime.learning;

      await publicLearning.promote(seeded.capabilityId, 'user');

      expect(await publicLearning.get(seeded.capabilityId)).toMatchObject({
        lifecycle: 'promoted_user',
        slug: seeded.slug,
      });
      expect(await readFile(
        join(homeDir, '.kodax', 'skills', seeded.slug, 'SKILL.md'),
        'utf8',
      )).toContain(seeded.contentNeedle);
      await runtime.close();
    },
  );

  it.each(['inline', 'worker'] as const)(
    'rejects an unsupported promotion scope without side effects in %s mode',
    async (isolation) => {
      const homeDir = await mkdtemp(join(tmpdir(), `kodax-${isolation}-learning-scope-`));
      tempDirs.push(homeDir);
      const seeded = await seedPromotableCapability(homeDir);
      const runtime = await createKodaXRuntime({ homeDir, isolation });
      try {
        await expect(runtime.learning.promote(
          seeded.capabilityId,
          'project' as unknown as 'user',
        )).rejects.toThrow();
        expect(await runtime.learning.get(seeded.capabilityId)).toMatchObject({
          lifecycle: 'ready',
        });
        await expect(access(
          join(homeDir, '.kodax', 'skills', seeded.slug, 'SKILL.md'),
        )).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await runtime.close();
      }
    },
  );

  it('forwards user-scope promotion through the public daemon Runtime facade', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport: RuntimeDaemonClientTransport = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'initialize') {
          return {
            identity: {
              runtimeId: 'learning-promote-daemon',
              mode: 'daemon',
              profile: 'default',
              startedAt: '2026-07-29T00:00:00.000Z',
              version: KODAX_VERSION,
            },
            capabilities: {
              learningCenter: { version: 1 },
              sessionEventJournal: { version: 1 },
              liveOutputSegments: { version: 1 },
              sandboxRuntime: { version: 10 },
              runtimeAutoModeGuardrail: { version: 5 },
              sharedSessionSettings: { version: 2 },
              skillLearningLoop: {
                version: 1,
                activation: 'project_scoped_canary',
                immutableDecisions: true,
                recordGatedDiscovery: true,
                exactUseAttribution: true,
                rollback: true,
              },
            },
            grantedScopes: ['learning:read', 'learning:control'],
          };
        }
        return { ok: true };
      },
      subscribe() {
        return { close() {} };
      },
    };
    const runtime = await createKodaXRuntime({
      mode: 'daemon',
      daemonTransport: transport,
      daemonToken: 'learning-promote-token',
      clientInfo: { name: 'learning-promote-test', version: '0.7.78' },
      requirements: { learningCenter: 1, skillLearningLoop: 1 },
    });

    await runtime.learning.promote('runtime-promote-skill', 'user');

    expect(calls).toContainEqual({
      method: 'learning.promote',
      params: { nameOrSlug: 'runtime-promote-skill', scope: 'user' },
    });
    await runtime.close();
  });
});
