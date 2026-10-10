import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  admitAndRecordLearnedSkillInvocation,
  admitLearnedSkillBinding,
  appendMemoryOutcomeDigest,
  commitLearnedSkillRevision,
  createLearnedCapabilityScope,
  createMemoryControlPlane,
  createSessionLineage,
  EpisodeReviewFailure,
  inspectEpisodeReviewJob,
  LearnedAreaStore,
  listPendingEpisodeReviews,
  persistPendingEpisodeReview,
  readLearningProposalStore,
  resolveProjectLearnedAreaRoot,
  resolveMemoryRoot,
  resolveScopedMemoryRoot,
  setAgentConfigHome,
  type KodaXMemoryOutcomeDigest,
  type KodaXSessionData,
  type MemoryContextIdentity,
  type PendingEpisodeReview,
} from '@kodax-ai/agent';
import { createMemoryAgent } from '@kodax-ai/agent/experimental-memory';

import type { KodaXOptions } from './types.js';
import {
  awaitLatestCodingMemoryReviewDrain,
  canonicalMemoryProjectId,
  appliedMemoryReviewSummaries,
  deriveCodingMemoryIdentity,
  drainCodingMemoryReviewInbox,
  maybeRunMemoryMaintenanceWindow,
  persistMemoryOutcomeToSession,
  persistMemoryReviewReceiptToSession,
  revalidatePendingEpisodeReview,
} from './memory-runtime.js';
import {
  buildToolMemoryObservations,
  codingMemorySourcePolicy,
} from './memory/coding-observations.js';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('memory runtime hooks', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    setAgentConfigHome(undefined);
    for (const dir of cleanupDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('derives stable scoped identity without exposing repository identity in paths', async () => {
    const cwd = await createTempDir('kodax-memory-runtime-identity-');
    const home = await createTempDir('kodax-memory-runtime-identity-home-');
    cleanupDirs.push(cwd, home);
    setAgentConfigHome(home);

    const identity = deriveCodingMemoryIdentity({
      provider: 'anthropic',
      context: {
        executionCwd: cwd,
        agentProfile: { id: 'partner-profile' },
      },
    }, cwd, 'session-1');

    expect(identity).toMatchObject({
      agentId: 'partner-profile',
      sessionId: 'session-1',
      userId: `local:${home}`,
    });
    expect(identity.tenantId).toContain(home);
    expect(identity.projectId).toContain(path.resolve(cwd).toLowerCase());
    const scopedRoot = resolveScopedMemoryRoot(identity, 'project');
    expect(scopedRoot).not.toContain(identity.tenantId);
    expect(scopedRoot).not.toContain(identity.projectId ?? 'missing');
  });

  it('canonicalizes repository identities without retaining remote credentials', () => {
    const https = canonicalMemoryProjectId(
      'https://oauth2:ghp_super_secret@GitHub.com/KodaX/Repo.git?token=also-secret',
    );
    const ssh = canonicalMemoryProjectId('git@github.com:KodaX/Repo.git');

    expect(https).toBe('remote:github.com/KodaX/Repo');
    expect(ssh).toBe(https);
    expect(https).not.toMatch(/ghp_|oauth|secret|token/i);
    expect(canonicalMemoryProjectId('not a parseable remote')).toMatch(/^remote-hash:[0-9a-f]{64}$/);
  });

  it('runs deterministic maintenance during a memory maintenance window', async () => {
    const cwd = await createTempDir('kodax-memory-runtime-cwd-');
    const home = await createTempDir('kodax-memory-runtime-home-');
    cleanupDirs.push(cwd, home);
    setAgentConfigHome(home);
    const memoryDir = resolveMemoryRoot(cwd);
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, 'alpha.md'),
      [
        '---',
        'name: Shared memory',
        'description: alpha duplicate',
        'type: project',
        '---',
        '',
        'same body',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(memoryDir, 'beta.md'),
      [
        '---',
        'name: Shared memory',
        'description: beta duplicate',
        'type: project',
        '---',
        '',
        'same body',
        '',
      ].join('\n'),
      'utf8',
    );

    await maybeRunMemoryMaintenanceWindow({
      provider: 'anthropic',
      context: { executionCwd: cwd },
    });

    await expect(pathExists(path.join(memoryDir, '.governance', 'auto-curate-state.json')))
      .resolves.toBe(true);
  });

  it('skips deterministic maintenance for internal child agent runs', async () => {
    const cwd = await createTempDir('kodax-memory-runtime-child-cwd-');
    const home = await createTempDir('kodax-memory-runtime-child-home-');
    cleanupDirs.push(cwd, home);
    setAgentConfigHome(home);
    const memoryDir = resolveMemoryRoot(cwd);
    await fs.mkdir(memoryDir, { recursive: true });
    for (const name of ['alpha.md', 'beta.md']) {
      await fs.writeFile(
        path.join(memoryDir, name),
        [
          '---',
          'name: Shared memory',
          'description: duplicate',
          'type: project',
          '---',
          '',
          'same body',
          '',
        ].join('\n'),
        'utf8',
      );
    }

    await maybeRunMemoryMaintenanceWindow({
      provider: 'anthropic',
      context: {
        executionCwd: cwd,
        currentAgentId: 'child-1',
        parentAgentId: 'worker',
      },
    });

    await expect(pathExists(path.join(memoryDir, '.governance', 'auto-curate-state.json')))
      .resolves.toBe(false);
  });

  it('persists outcome digest and review receipt as context-silent lineage entries', async () => {
    const data = {
      messages: [{ role: 'user' as const, content: 'test' }],
      title: 'test',
      gitRoot: '.',
    };
    const storage = {
      save: async (_id: string, next: typeof data & { lineage?: import('@kodax-ai/agent').KodaXSessionLineage }) => {
        Object.assign(data, next);
      },
      load: async () => data as typeof data & { lineage?: import('@kodax-ai/agent').KodaXSessionLineage },
      list: async () => [],
      delete: async () => true,
    };
    const options: KodaXOptions = { provider: 'anthropic', session: { storage } };
    const digest = {
      id: 'digest-1',
      reviewKey: 'review-1',
      sessionId: 'session-1',
      branchId: 'session-1',
      sequence: 1,
      objective: 'Test',
      approach: 'Run test',
      outcome: 'succeeded' as const,
      summary: 'Passed',
      evidenceRefs: ['tool:test'],
      visibility: 'prompt_safe' as const,
      createdAt: '2026-07-12T00:00:00.000Z',
    };

    await persistMemoryOutcomeToSession(options, 'session-1', digest);
    await persistMemoryReviewReceiptToSession(options, 'session-1', {
      reviewKey: 'review-1',
      proposalIds: ['proposal-1'],
      completedAt: '2026-07-12T00:01:00.000Z',
    });

    expect((data as typeof data & { lineage?: import('@kodax-ai/agent').KodaXSessionLineage })
      .lineage?.entries.map((entry) => entry.type)).toEqual([
        'message',
        'memory_outcome_digest',
        'memory_review_receipt',
      ]);
  });

  it('revalidates delayed reviews against owner existence and rewind state', async () => {
    const digest = {
      id: 'digest-1',
      reviewKey: 'review-1',
      sessionId: 'session-1',
      branchId: 'session-1',
      sequence: 1,
      objective: 'Test',
      approach: 'Run test',
      outcome: 'succeeded' as const,
      summary: 'Passed',
      evidenceRefs: ['tool:test'],
      visibility: 'prompt_safe' as const,
      createdAt: '2026-07-12T00:00:00.000Z',
    };
    const pending: PendingEpisodeReview = {
      version: 1,
      reviewKey: digest.reviewKey,
      digest,
      ownerSessionRef: digest.sessionId,
      ownerAgentHash: 'agent-hash',
      createdAt: digest.createdAt,
    };
    const base = createSessionLineage([{ role: 'user', content: 'test' }]);
    const storage = (lineage: import('@kodax-ai/agent').KodaXSessionLineage | null) => ({
      save: async () => undefined,
      load: async () => lineage === null ? null : {
        messages: [{ role: 'user' as const, content: 'test' }],
        title: 'test',
        gitRoot: '.',
        lineage,
      },
    });

    await expect(revalidatePendingEpisodeReview(undefined, pending)).resolves.toBe('defer');
    await expect(revalidatePendingEpisodeReview(storage(null), pending)).resolves.toBe('discard');
    await expect(revalidatePendingEpisodeReview(
      storage(appendMemoryOutcomeDigest(base, digest)),
      pending,
    )).resolves.toBe('eligible');
    await expect(revalidatePendingEpisodeReview(storage({
      ...base,
      entries: [...base.entries, {
        type: 'rewind_marker',
        id: 'rewind-1',
        logicalId: 'rewind-1',
        parentId: base.activeEntryId,
        timestamp: '2026-07-12T00:01:00.000Z',
        targetId: base.activeEntryId!,
        truncatedCount: 1,
        summary: 'rewound',
      }],
    }), pending)).resolves.toBe('discard');
  });

  it('keeps durable receipt state idempotent while retrying event delivery at least once', async () => {
    let data: KodaXSessionData = {
      messages: [{ role: 'user', content: 'test' }],
      title: 'test',
      gitRoot: '.',
    };
    const emitted: string[] = [];
    const options: KodaXOptions = {
      provider: 'anthropic',
      session: {
        storage: {
          save: async (_id, next) => { data = next; },
          load: async () => data,
        },
      },
      events: {
        onMemoryReviewReceipt: (receipt) => emitted.push(receipt.reviewKey),
      },
    };
    const receipt = {
      jobId: 'job-1',
      reviewKey: 'review-1',
      proposalIds: ['proposal-1'],
      completedAt: '2026-07-27T00:01:00.000Z',
    };

    await expect(persistMemoryReviewReceiptToSession(options, 'session-1', receipt))
      .resolves.toBeUndefined();
    await expect(persistMemoryReviewReceiptToSession(options, 'session-1', receipt))
      .resolves.toBeUndefined();

    expect(emitted).toEqual(['review-1', 'review-1']);
    expect(data.lineage?.entries.filter((entry) => entry.type === 'memory_review_receipt'))
      .toHaveLength(1);
  });

  it('durably commits the receipt and notice before retrying a failed host callback', async () => {
    let data: KodaXSessionData = {
      messages: [{ role: 'user', content: 'test' }],
      title: 'test',
      gitRoot: '.',
    };
    let receiptAttempts = 0;
    const notices: string[] = [];
    const options: KodaXOptions = {
      provider: 'anthropic',
      session: {
        persistedByHost: true,
        storage: {
          save: async (_id, next) => { data = next; },
          load: async () => data,
          mutateLineage: async (_id, mutation) => {
            const lineage = data.lineage ?? createSessionLineage(data.messages);
            const nextLineage = mutation(lineage);
            if (nextLineage !== lineage) data = { ...data, lineage: nextLineage };
            return true;
          },
        },
      },
      events: {
        onMemoryReviewReceipt: () => {
          receiptAttempts += 1;
          if (receiptAttempts === 1) throw new Error('simulated host callback crash');
        },
        onMemoryNotice: (notice) => notices.push(notice.episodeId),
      },
    };
    const receipt = {
      jobId: 'job-crash',
      reviewKey: 'review-crash',
      proposalIds: ['proposal-crash'],
      completedAt: '2026-07-27T00:01:00.000Z',
      notice: {
        episodeId: 'episode-crash',
        summaries: ['Applied durable update'],
        proposalIds: ['proposal-crash'],
      },
    };

    await expect(persistMemoryReviewReceiptToSession(options, 'session-1', receipt))
      .rejects.toThrow('simulated host callback crash');
    expect(data.lineage?.entries.filter((entry) => entry.type === 'memory_review_receipt'))
      .toHaveLength(1);
    expect(data.lineage?.entries.filter((entry) => entry.type === 'client_notice'))
      .toHaveLength(1);

    await expect(persistMemoryReviewReceiptToSession(options, 'session-1', receipt))
      .resolves.toBeUndefined();
    expect(receiptAttempts).toBe(2);
    expect(notices).toEqual(['episode-crash']);
    expect(data.lineage?.entries.filter((entry) => entry.type === 'memory_review_receipt'))
      .toHaveLength(1);
    expect(data.lineage?.entries.filter((entry) => entry.type === 'client_notice'))
      .toHaveLength(1);
  });

  it('persists a fenced outcome before notifying a host-persisted session', async () => {
    let data: KodaXSessionData = {
      messages: [{ role: 'user', content: 'test' }],
      title: 'test',
      gitRoot: '.',
    };
    const emitted: string[] = [];
    const options: KodaXOptions = {
      provider: 'anthropic',
      session: {
        persistedByHost: true,
        storage: {
          save: async (_id, next) => { data = next; },
          load: async () => data,
          mutateLineage: async (_id, mutation) => {
            const lineage = data.lineage ?? createSessionLineage(data.messages);
            const nextLineage = mutation(lineage);
            if (nextLineage !== lineage) data = { ...data, lineage: nextLineage };
            return true;
          },
        },
      },
      events: {
        onMemoryOutcomeDigest: (digest) => emitted.push(digest.id),
      },
    };
    const digest = {
      id: 'digest-host',
      reviewKey: 'review-host',
      sessionId: 'session-1',
      branchId: 'session-1',
      sequence: 1,
      objective: 'Test',
      approach: 'Run test',
      outcome: 'succeeded' as const,
      summary: 'Passed',
      evidenceRefs: ['tool:test'],
      visibility: 'prompt_safe' as const,
      createdAt: '2026-07-27T00:00:00.000Z',
    };

    await persistMemoryOutcomeToSession(options, 'session-1', digest, { jobId: 'job-host' });

    expect(data.lineage?.entries).toContainEqual(expect.objectContaining({
      type: 'memory_outcome_digest',
      jobId: 'job-host',
    }));
    expect(emitted).toEqual(['digest-host']);
  });

  it('fails closed when host-owned storage cannot atomically persist the outcome', async () => {
    const emitted: string[] = [];
    const options: KodaXOptions = {
      provider: 'anthropic',
      session: {
        persistedByHost: true,
        storage: {
          save: async () => { throw new Error('read-only host storage'); },
          load: async () => ({
            messages: [{ role: 'user', content: 'test' }],
            title: 'test',
            gitRoot: '.',
          }),
        },
      },
      events: {
        onMemoryOutcomeDigest: (digest) => emitted.push(digest.id),
      },
    };
    const digest = {
      id: 'digest-event-only',
      reviewKey: 'review-event-only',
      sessionId: 'session-1',
      branchId: 'session-1',
      sequence: 1,
      objective: 'Test',
      approach: 'Run test',
      outcome: 'succeeded' as const,
      summary: 'Passed',
      evidenceRefs: ['tool:test'],
      visibility: 'prompt_safe' as const,
      createdAt: '2026-07-27T00:00:00.000Z',
    };

    await expect(persistMemoryOutcomeToSession(options, 'session-1', digest))
      .rejects.toThrow('atomic lineage mutation');
    expect(emitted).toEqual([]);
  });

  it('fails closed without events when the atomic mutation cannot find the owner session', async () => {
    const outcomes: string[] = [];
    const receipts: string[] = [];
    const notices: string[] = [];
    const options: KodaXOptions = {
      provider: 'anthropic',
      session: {
        persistedByHost: true,
        storage: {
          save: async () => undefined,
          load: async () => null,
          mutateLineage: async () => false,
        },
      },
      events: {
        onMemoryOutcomeDigest: (digest) => outcomes.push(digest.id),
        onMemoryReviewReceipt: (receipt) => receipts.push(receipt.reviewKey),
        onMemoryNotice: (notice) => notices.push(notice.episodeId),
      },
    };
    const digest = {
      id: 'digest-missing-owner',
      reviewKey: 'review-missing-owner',
      sessionId: 'missing-owner',
      branchId: 'missing-owner',
      sequence: 1,
      objective: 'Test missing owner',
      approach: 'Persist atomically',
      outcome: 'succeeded' as const,
      summary: 'Passed',
      evidenceRefs: ['tool:test'],
      visibility: 'prompt_safe' as const,
      createdAt: '2026-07-27T00:00:00.000Z',
    };

    await expect(persistMemoryOutcomeToSession(options, 'missing-owner', digest))
      .rejects.toThrow('owner session was not found');
    await expect(persistMemoryReviewReceiptToSession(options, 'missing-owner', {
      reviewKey: digest.reviewKey,
      proposalIds: ['proposal-missing-owner'],
      completedAt: '2026-07-27T00:01:00.000Z',
      notice: {
        episodeId: 'episode-missing-owner',
        summaries: ['Should not be emitted'],
        proposalIds: ['proposal-missing-owner'],
      },
    })).rejects.toThrow('owner session was not found');

    expect({ outcomes, receipts, notices }).toEqual({
      outcomes: [],
      receipts: [],
      notices: [],
    });
  });

  it('filters legacy Memory notices to exactly applied proposal summaries', () => {
    expect(appliedMemoryReviewSummaries({
      plan: {
        trigger: 'episode_outcome',
        createdAt: '2026-07-27T00:00:00.000Z',
        sourceRefs: [],
        candidateRefs: [],
        actions: [
          {
            action: 'write_memdir',
            targetRefIds: [],
            summary: 'Applied summary',
            rationale: 'Verified.',
            confidence: 'high',
            risk: 'low',
            requiresApproval: true,
            proposedBody: 'Applied body.',
            claimKind: 'fact',
            claimKey: 'project.applied-summary',
          },
          {
            action: 'write_memdir',
            targetRefIds: [],
            summary: 'Pending summary',
            rationale: 'Risky.',
            confidence: 'high',
            risk: 'high',
            requiresApproval: true,
            proposedBody: 'Pending body.',
            claimKind: 'fact',
            claimKey: 'project.pending-summary',
          },
        ],
        warnings: [],
      },
      proposalIds: ['proposal-applied', 'proposal-pending'],
      appliedProposalIds: ['proposal-applied'],
      decisions: [
        { actionIndex: 0, kind: 'create', reason: 'new', proposalId: 'proposal-applied' },
        { actionIndex: 1, kind: 'create', reason: 'new', proposalId: 'proposal-pending' },
      ],
      warnings: [],
    })).toEqual(['Applied summary']);
  });

  it('fails closed when a v2 review job has no exact lineage digest', async () => {
    const digest = {
      id: 'digest-v2-missing',
      reviewKey: 'review-v2-missing',
      sessionId: 'session-v2',
      branchId: 'session-v2',
      sequence: 1,
      objective: 'Test',
      approach: 'Run test',
      outcome: 'succeeded' as const,
      summary: 'Passed',
      evidenceRefs: ['tool:test'],
      visibility: 'prompt_safe' as const,
      createdAt: '2026-07-27T00:00:00.000Z',
    };
    const pending: PendingEpisodeReview = {
      version: 2,
      jobId: 'job-v2-missing',
      reviewKey: digest.reviewKey,
      digest,
      ownerSessionRef: digest.sessionId,
      ownerAgentHash: 'agent-hash',
      branchId: digest.branchId,
      branchEpoch: 0,
      authorityCeiling: 'memory_and_project_skill',
      createdAt: digest.createdAt,
    };
    const lineage = createSessionLineage([{ role: 'user', content: 'test' }]);
    const storage = {
      save: async () => undefined,
      load: async () => ({
        messages: [{ role: 'user' as const, content: 'test' }],
        title: 'test',
        gitRoot: '.',
        lineage,
      }),
    };

    await expect(revalidatePendingEpisodeReview(storage, pending)).resolves.toBe('discard');
  });

  it('persists a delayed receipt to its owner session instead of the active host session', async () => {
    const owner = {
      messages: [{ role: 'user' as const, content: 'owner' }],
      title: 'owner',
      gitRoot: '.',
    };
    const active = {
      messages: [{ role: 'user' as const, content: 'active' }],
      title: 'active',
      gitRoot: '.',
    };
    const sessions = new Map<string, KodaXSessionData>([
      ['owner-session', owner],
      ['active-session', active],
    ]);
    const emitted: Array<{
      readonly sessionId?: string;
      readonly reviewKey: string;
    }> = [];
    const options: KodaXOptions = {
      provider: 'anthropic',
      session: {
        id: 'active-session',
        storage: {
          save: async (id, data) => {
            sessions.set(id, data);
          },
          load: async (id) => sessions.get(id) ?? null,
        },
      },
      events: {
        onMemoryReviewReceipt: (receipt) => emitted.push(receipt),
      },
    };

    await persistMemoryReviewReceiptToSession(options, 'owner-session', {
      reviewKey: 'review-owner',
      proposalIds: ['proposal-owner'],
      completedAt: '2026-07-27T00:01:00.000Z',
    });

    expect(emitted).toEqual([{
      sessionId: 'owner-session',
      reviewKey: 'review-owner',
      proposalIds: ['proposal-owner'],
      completedAt: '2026-07-27T00:01:00.000Z',
    }]);
    expect(sessions.get('owner-session')?.lineage?.entries.at(-1)).toMatchObject({
      type: 'memory_review_receipt',
      reviewKey: 'review-owner',
    });
    expect(sessions.get('active-session')?.lineage).toBeUndefined();
  });

  it('uses atomic lineage mutation for a delayed foreign-owner receipt when available', async () => {
    let owner: KodaXSessionData = {
      messages: [{ role: 'user', content: 'owner' }],
      title: 'owner',
      gitRoot: '.',
    };
    let loads = 0;
    let saves = 0;
    let mutations = 0;
    const options: KodaXOptions = {
      provider: 'anthropic',
      session: {
        id: 'active-session',
        persistedByHost: true,
        storage: {
          save: async () => { saves += 1; },
          load: async () => {
            loads += 1;
            return owner;
          },
          mutateLineage: async (id, mutation) => {
            expect(id).toBe('owner-session');
            mutations += 1;
            const lineage = owner.lineage ?? createSessionLineage(owner.messages);
            owner = { ...owner, lineage: mutation(lineage) };
            return true;
          },
        },
      },
    };

    await persistMemoryReviewReceiptToSession(options, 'owner-session', {
      reviewKey: 'review-owner-atomic',
      proposalIds: ['proposal-owner-atomic'],
      completedAt: '2026-07-27T00:01:00.000Z',
    });

    expect({ loads, saves, mutations }).toEqual({ loads: 0, saves: 0, mutations: 1 });
    expect(owner.lineage?.entries.at(-1)).toMatchObject({
      type: 'memory_review_receipt',
      reviewKey: 'review-owner-atomic',
    });
  });

  it('commits one fenced unified review into Memory and a project canary Skill', async () => {
    const cwd = await createTempDir('kodax-memory-runtime-unified-');
    const home = await createTempDir('kodax-memory-runtime-unified-home-');
    cleanupDirs.push(cwd, home);
    setAgentConfigHome(home);
    const identity: MemoryContextIdentity = {
      configHome: home,
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      projectId: 'project-a',
      sessionId: 'session-a',
    };
    const digest: KodaXMemoryOutcomeDigest = {
      id: 'digest-unified-1',
      reviewKey: 'review-unified-1',
      sessionId: identity.sessionId,
      branchId: identity.sessionId,
      sequence: 1,
      objective: 'Verify a release candidate',
      approach: 'Run the complete release checks',
      outcome: 'succeeded',
      summary: 'Please preserve this verified release method as a skill.',
      evidenceRefs: ['check:release'],
      evidence: [{
        ref: 'check:release',
        grade: 'verified',
        source: 'tool',
        verdict: 'passed',
        observedAt: '2026-07-27T00:00:00.000Z',
      }],
      actionSignature: 'release:verify',
      lesson: 'Run the complete release checks before publishing.',
      preconditions: 'A release candidate is ready.',
      visibility: 'prompt_safe',
      createdAt: '2026-07-27T00:00:00.000Z',
    };
    const pending = await persistPendingEpisodeReview(identity, digest);
    expect(pending.entry.version).toBe(2);
    const pendingJobId = pending.entry.version === 2
      ? pending.entry.jobId
      : undefined;
    let sessionData: KodaXSessionData = {
      messages: [{ role: 'user', content: 'Verify release' }],
      title: 'release',
      gitRoot: cwd,
      lineage: appendMemoryOutcomeDigest(
        createSessionLineage([{ role: 'user', content: 'Verify release' }]),
        digest,
        pendingJobId,
      ),
    };
    let fullSaves = 0;
    let lineageMutations = 0;
    const storage = {
      save: async (id: string, data: KodaXSessionData) => {
        fullSaves += 1;
        if (id === identity.sessionId) sessionData = data;
      },
      load: async (id: string) => id === identity.sessionId ? sessionData : null,
      mutateLineage: async (id: string, mutation: (
        lineage: import('@kodax-ai/agent').KodaXSessionLineage,
      ) => import('@kodax-ai/agent').KodaXSessionLineage) => {
        if (id !== identity.sessionId) return false;
        lineageMutations += 1;
        const lineage = sessionData.lineage ?? createSessionLineage(sessionData.messages);
        const nextLineage = mutation(lineage);
        if (nextLineage !== lineage) sessionData = { ...sessionData, lineage: nextLineage };
        return true;
      },
      list: async () => [{
        id: identity.sessionId,
        title: sessionData.title,
        msgCount: sessionData.messages.length,
      }],
    };
    let reviewedInput: import('@kodax-ai/agent').UnifiedLearningReviewModelInput | undefined;
    const notices: Array<{
      readonly summaries: readonly string[];
      readonly proposalIds: readonly string[];
    }> = [];
    const options: KodaXOptions = {
      provider: 'anthropic',
      context: { executionCwd: cwd, configHome: home },
      session: { id: identity.sessionId, persistedByHost: true, storage },
      learningReviewer: async (input) => {
        reviewedInput = input;
        return {
          memoryPlan: {
            trigger: input.memory.trigger,
            createdAt: '2026-07-27T00:01:00.000Z',
            sourceRefs: input.memory.sourceRefs,
            candidateRefs: input.memory.candidateRefs,
            actions: [{
              action: 'write_memdir',
              targetRefIds: [],
              summary: 'Apply verified release memory',
              rationale: 'The release evidence passed.',
              confidence: 'high',
              risk: 'low',
              requiresApproval: true,
              proposedBody: 'Run the complete release checks before publishing.',
              claimKind: 'procedure',
              claimKey: 'project.release-checks',
            }, {
              action: 'write_memdir',
              targetRefIds: [],
              summary: 'Keep risky release memory pending',
              rationale: 'This broader claim needs approval.',
              confidence: 'high',
              risk: 'high',
              requiresApproval: true,
              proposedBody: 'Assume every release check is interchangeable.',
              claimKind: 'policy',
              claimKey: 'project.release-check-interchangeability',
            }],
            warnings: [],
          },
          capabilityDecision: {
            disposition: 'project_canary',
            reasonCodes: ['explicit_preserve_as_skill'],
            requestedScope: 'project',
            semanticDisposition: 'allow',
            operation: 'create',
            spec: {
              name: 'verify-release',
              description: 'Use when validating a release candidate before publishing.',
              purpose: 'Validate a release candidate with reproducible evidence.',
              triggers: ['A release candidate needs a final verification pass.'],
              steps: ['Run the complete release checks.'],
              verification: ['Require passing tests and an explicit version check.'],
              pitfalls: ['Do not infer success from incomplete output.'],
            },
          },
        };
      },
      events: {
        onMemoryNotice: (notice) => notices.push({
          summaries: notice.summaries,
          proposalIds: notice.proposalIds,
        }),
      },
    };
    const controller = createMemoryControlPlane({
      cwd,
      identity,
      projectDocs: [],
      discoverSkills: false,
    });

    const result = await drainCodingMemoryReviewInbox(
      options,
      identity,
      controller,
      '',
    );

    expect(result?.failures).toEqual([]);
    expect(result).toMatchObject({ reviewed: 1, failed: 0 });
    expect({ fullSaves, lineageMutations }).toEqual({ fullSaves: 0, lineageMutations: 1 });
    expect(reviewedInput?.evidence.qualification).toMatchObject({
      reusableMethodEvidence: true,
      explicitSkillPreservation: true,
      independentEpisodeCount: 1,
      verifiedOutcome: true,
    });
    const store = new LearnedAreaStore(resolveProjectLearnedAreaRoot(home, {
      tenantId: identity.tenantId,
      projectId: identity.projectId,
    }));
    await store.initialize();
    expect(await store.listCapabilities()).toMatchObject([{
      schemaVersion: 2,
      slug: 'verify-release',
      lifecycle: 'testing',
      canary: { maxInvocations: 3, invocationCount: 0 },
    }]);
    expect(sessionData.lineage?.entries.find((entry) => entry.type === 'memory_review_receipt'))
      .toMatchObject({
      proposalIds: [expect.any(String), expect.any(String)],
    });
    expect(sessionData.lineage?.entries.at(-1)).toMatchObject({
      type: 'client_notice',
      payload: { episodeId: digest.id },
    });
    expect(notices).toEqual([{
      summaries: [expect.not.stringContaining('pending')],
      proposalIds: [expect.any(String)],
    }]);
    await expect(listPendingEpisodeReviews({
      configHome: home,
      tenantId: identity.tenantId,
    })).resolves.toEqual([]);
  });

  it('reviews and quarantines an exact invocation from the local root after remote identity recovers', async () => {
    const cwd = await createTempDir('kodax-memory-runtime-cross-root-');
    const home = await createTempDir('kodax-memory-runtime-cross-root-home-');
    cleanupDirs.push(cwd, home);
    const localProjectId = `local:${path.resolve(cwd).toLowerCase()}`;
    const identity: MemoryContextIdentity = {
      configHome: home,
      tenantId: 'tenant-cross-root',
      agentId: 'agent-cross-root',
      projectId: 'remote:example.com/team/project',
      sessionId: 'session-cross-root',
    };
    const localStore = new LearnedAreaStore(resolveProjectLearnedAreaRoot(home, {
      tenantId: identity.tenantId,
      projectId: localProjectId,
    }));
    await localStore.initialize();
    const learned = await commitLearnedSkillRevision(localStore, {
      scope: createLearnedCapabilityScope(home, {
        tenantId: identity.tenantId,
        projectId: localProjectId,
      }),
      spec: {
        name: 'verify-local-release',
        description: 'Use when verifying this project before release.',
        purpose: 'Verify the release with reproducible checks.',
        triggers: ['A release candidate needs verification.'],
        steps: ['Run the release test suite.'],
        verification: ['Require a passing test artifact.'],
        pitfalls: ['Do not trust incomplete output.'],
      },
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-cross-root-create',
        inputHash: 'a'.repeat(64),
        decisionId: 'decision-cross-root-create',
        actionId: 'action-cross-root-create',
      },
    });
    const remoteStore = new LearnedAreaStore(resolveProjectLearnedAreaRoot(home, {
      tenantId: identity.tenantId,
      projectId: identity.projectId,
    }));
    await remoteStore.initialize();
    await remoteStore.writeCapability(learned);
    const bindingId = 'episode-cross-root';
    await admitLearnedSkillBinding(localStore, learned.capabilityId, {
      bindingId,
      ownerSessionRef: identity.sessionId,
    });
    await admitAndRecordLearnedSkillInvocation(localStore, {
      sessionId: identity.sessionId,
      ownerSessionRef: identity.sessionId,
      bindingId,
      capabilityId: learned.capabilityId,
      expectedRevision: learned.artifact.contentRevision,
      expectedFingerprint: learned.artifact.fingerprint,
      invocationId: 'invocation-cross-root',
    });
    const digest: KodaXMemoryOutcomeDigest = {
      id: 'digest-cross-root',
      reviewKey: 'review-cross-root',
      episodeId: bindingId,
      sessionId: identity.sessionId,
      branchId: identity.sessionId,
      sequence: 1,
      objective: 'Verify a release candidate',
      approach: 'Use the learned release procedure.',
      outcome: 'failed',
      summary: 'The exact learned procedure contradicted verified evidence.',
      evidenceRefs: ['check:release'],
      evidence: [{
        ref: 'check:release',
        grade: 'verified',
        source: 'tool',
        verdict: 'failed',
        observedAt: '2026-08-09T00:00:00.000Z',
      }],
      visibility: 'prompt_safe',
      createdAt: '2026-08-09T00:00:00.000Z',
    };
    const pending = await persistPendingEpisodeReview({
      ...identity,
      projectId: localProjectId,
    }, digest);
    if (pending.entry.version !== 2) throw new Error('expected v2 review job');
    let sessionData: KodaXSessionData = {
      messages: [{ role: 'user', content: 'Verify release' }],
      title: 'cross-root review',
      gitRoot: cwd,
      lineage: appendMemoryOutcomeDigest(
        createSessionLineage([{ role: 'user', content: 'Verify release' }]),
        digest,
        pending.entry.jobId,
      ),
    };
    const options: KodaXOptions = {
      provider: 'anthropic',
      context: { executionCwd: cwd, configHome: home },
      session: {
        id: identity.sessionId,
        persistedByHost: true,
        storage: {
          load: async (id) => id === identity.sessionId ? sessionData : null,
          save: async (id, data) => {
            if (id === identity.sessionId) sessionData = data;
          },
          mutateLineage: async (id, mutation) => {
            if (id !== identity.sessionId) return false;
            const lineage = sessionData.lineage ?? createSessionLineage(sessionData.messages);
            sessionData = { ...sessionData, lineage: mutation(lineage) };
            return true;
          },
        },
      },
      learningReviewer: async (input) => {
        expect(input.evidence.exactInvokedSkill).toMatchObject({
          capabilityId: learned.capabilityId,
          fingerprint: learned.artifact.fingerprint,
          invocationId: 'invocation-cross-root',
        });
        expect(input.evidence.qualification).toMatchObject({
          exactSkillInvoked: true,
          verifiedOutcome: true,
        });
        expect(input.evidence.verifierFacts).toContainEqual({
          ref: 'check:release',
          verdict: 'failed',
        });
        return {
          memoryPlan: {
            trigger: input.memory.trigger,
            createdAt: '2026-08-09T00:01:00.000Z',
            sourceRefs: input.memory.sourceRefs,
            candidateRefs: input.memory.candidateRefs,
            actions: [],
            warnings: [],
          },
          capabilityDecision: {
            disposition: 'discard',
            reasonCodes: ['rule_level_contradiction'],
          },
        };
      },
    };
    const controller = createMemoryControlPlane({
      cwd,
      identity,
      projectDocs: [],
      discoverSkills: false,
    });

    await expect(drainCodingMemoryReviewInbox(options, identity, controller, ''))
      .resolves.toMatchObject({ reviewed: 1, failed: 0 });
    await expect(localStore.readCapability(learned.capabilityId)).resolves.toMatchObject({
      lifecycle: 'quarantined',
    });
    await expect(remoteStore.readCapability(learned.capabilityId)).resolves.toMatchObject({
      lifecycle: 'testing',
    });
  });

  it('does not report Memory updated for a proposal that remains pending approval', async () => {
    const cwd = await createTempDir('kodax-memory-runtime-pending-');
    const home = await createTempDir('kodax-memory-runtime-pending-home-');
    cleanupDirs.push(cwd, home);
    const identity: MemoryContextIdentity = {
      configHome: home,
      tenantId: 'tenant-pending',
      agentId: 'agent-pending',
      projectId: 'project-pending',
      sessionId: 'session-pending',
    };
    const digest: KodaXMemoryOutcomeDigest = {
      id: 'digest-pending-1',
      reviewKey: 'review-pending-1',
      sessionId: identity.sessionId,
      branchId: identity.sessionId,
      sequence: 1,
      objective: 'Try an unverified procedure',
      approach: 'Rely on an agent assertion',
      outcome: 'succeeded',
      summary: 'The agent asserted that this procedure works.',
      evidenceRefs: ['agent:self-claim'],
      evidence: [{
        ref: 'agent:self-claim',
        grade: 'inferred',
        source: 'agent',
        observedAt: '2026-07-27T00:00:00.000Z',
      }],
      visibility: 'prompt_safe',
      createdAt: '2026-07-27T00:00:00.000Z',
    };
    const pending = await persistPendingEpisodeReview(identity, digest);
    if (pending.entry.version !== 2) throw new Error('expected v2 review job');
    let sessionData: KodaXSessionData = {
      messages: [{ role: 'user', content: 'Try procedure' }],
      title: 'pending memory',
      gitRoot: cwd,
      lineage: appendMemoryOutcomeDigest(
        createSessionLineage([{ role: 'user', content: 'Try procedure' }]),
        digest,
        pending.entry.jobId,
      ),
    };
    const notices: string[][] = [];
    const options: KodaXOptions = {
      provider: 'anthropic',
      context: { executionCwd: cwd, configHome: home },
      session: {
        storage: {
          save: async (id, data) => {
            if (id === identity.sessionId) sessionData = data;
          },
          load: async (id) => id === identity.sessionId ? sessionData : null,
        },
      },
      events: {
        onMemoryNotice: (notice) => notices.push([...notice.proposalIds]),
      },
      learningReviewer: async (input) => ({
        memoryPlan: {
          trigger: input.memory.trigger,
          createdAt: '2026-07-27T00:01:00.000Z',
          sourceRefs: input.memory.sourceRefs,
          candidateRefs: input.memory.candidateRefs,
          actions: [{
            action: 'write_memdir',
            targetRefIds: [],
            summary: 'Keep the asserted procedure for approval',
            rationale: 'The evidence is not independently verified.',
            confidence: 'high',
            risk: 'low',
            requiresApproval: true,
            proposedBody: 'Use the asserted procedure only after independent approval.',
            claimKind: 'procedure',
            claimKey: 'project.asserted-procedure',
          }],
          warnings: [],
        },
      }),
    };
    const controller = createMemoryControlPlane({
      cwd,
      identity,
      projectDocs: [],
      discoverSkills: false,
    });

    await expect(drainCodingMemoryReviewInbox(options, identity, controller, ''))
      .resolves.toMatchObject({ reviewed: 1, failed: 0 });
    expect(notices).toEqual([]);
    expect(sessionData.lineage?.entries.at(-1)).toMatchObject({
      type: 'memory_review_receipt',
      proposalIds: [expect.stringMatching(/^memory-review-/)],
      status: 'completed',
    });
  });

  it('produces canary-qualifying evidence from the real verification observation pipeline', async () => {
    const cwd = await createTempDir('kodax-memory-runtime-real-evidence-');
    const home = await createTempDir('kodax-memory-runtime-real-evidence-home-');
    cleanupDirs.push(cwd, home);
    const identity: MemoryContextIdentity = {
      configHome: home,
      tenantId: 'tenant-real',
      agentId: 'agent-real',
      projectId: 'project-real',
      sessionId: 'session-real',
    };
    const controller = createMemoryControlPlane({
      cwd,
      identity,
      projectDocs: [],
      discoverSkills: false,
    });
    const digests: KodaXMemoryOutcomeDigest[] = [];
    const session = await createMemoryAgent({
      controlPlane: controller,
      sourcePolicy: codingMemorySourcePolicy,
      persistOutcomeDigest: async (digest) => {
        digests.push(digest);
      },
    }).startSession({
      identity,
      objective: 'Please preserve the verified release procedure as a Skill.',
    });
    const observations = buildToolMemoryObservations({
      toolBlocks: [{
        type: 'tool_use',
        id: 'check-release',
        name: 'bash',
        input: { command: 'npm test' },
      }],
      toolResults: [{
        type: 'tool_result',
        tool_use_id: 'check-release',
        content: 'Tests: 42 passed',
      }],
      startSequence: 0,
      observedAt: '2026-07-27T00:00:00.000Z',
      decisionActionSignature: 'task:verify-release',
    });
    session.observe(observations[0]!);

    await session.complete({
      status: 'succeeded',
      summary: 'Please preserve this verified release procedure as a Skill.',
      evidence: [{
        ref: 'artifact:release-check',
        requestedGrade: 'verified',
        source: 'tool',
        verdict: 'passed',
        observedAt: '2026-07-27T00:00:01.000Z',
      }],
    });

    expect(digests).toMatchObject([{
      outcome: 'succeeded',
      actionSignature: expect.stringMatching(/^bash:verify:[a-f0-9]{16}$/),
      lesson: 'Run `npm test` and require a successful verifier result.',
      // FEATURE_290 §3.2: the verification observation's evidence is merged
      // into the digest evidence after the completion-supplied entry.
      evidence: [{
        ref: 'artifact:release-check',
        grade: 'verified',
        verdict: 'passed',
      }, {
        ref: 'tool-result:check-release',
        grade: 'verified',
        source: 'tool',
        verdict: 'passed',
        observedAt: '2026-07-27T00:00:00.000Z',
      }],
    }]);
  });

  // Shared fixture for the FEATURE_290 §3.3/§3.4, FEATURE_289 §3.6 and drain
  // deadline/await tests: one failed episode digest carrying a sanitized
  // lesson and a failed verified verdict.
  async function failedLessonDrainFixture(
    learningReviewer: NonNullable<KodaXOptions['learningReviewer']>,
  ) {
    const cwd = await createTempDir('kodax-memory-runtime-failed-lesson-');
    const home = await createTempDir('kodax-memory-runtime-failed-lesson-home-');
    cleanupDirs.push(cwd, home);
    const identity: MemoryContextIdentity = {
      configHome: home,
      tenantId: 'tenant-failed',
      agentId: 'agent-failed',
      projectId: 'project-failed',
      sessionId: 'session-failed',
    };
    const learningStorePath = path.join(home, 'learning', 'proposals.json');
    const controller = createMemoryControlPlane({
      cwd,
      identity,
      learningStorePath,
      projectDocs: [],
      discoverSkills: false,
    });
    const digest: KodaXMemoryOutcomeDigest = {
      id: 'digest-failed-lesson-1',
      reviewKey: 'review-failed-lesson-1',
      sessionId: identity.sessionId,
      branchId: identity.sessionId,
      sequence: 1,
      objective: 'Verify a release candidate',
      approach: 'Run the release verification command.',
      outcome: 'failed',
      summary: 'The release verification failed.',
      evidenceRefs: ['tool-result:check-release'],
      evidence: [{
        ref: 'tool-result:check-release',
        grade: 'verified',
        source: 'tool',
        verdict: 'failed',
        observedAt: '2026-07-27T00:00:00.000Z',
      }],
      actionSignature: 'bash:verify:0123456789abcdef',
      lesson: 'A `bash` call with these inputs failed before. Inspect the referenced tool result and adjust the inputs before retrying.',
      visibility: 'prompt_safe',
      createdAt: '2026-07-27T00:00:00.000Z',
    };
    const pending = await persistPendingEpisodeReview(identity, digest);
    let sessionData: KodaXSessionData = {
      messages: [{ role: 'user', content: 'Verify release' }],
      title: 'release',
      gitRoot: cwd,
      lineage: appendMemoryOutcomeDigest(
        createSessionLineage([{ role: 'user', content: 'Verify release' }]),
        digest,
        pending.entry.version === 2 ? pending.entry.jobId : undefined,
      ),
    };
    const storage = {
      save: async (id: string, data: KodaXSessionData) => {
        if (id === identity.sessionId) sessionData = data;
      },
      load: async (id: string) => id === identity.sessionId ? sessionData : null,
      mutateLineage: async (id: string, mutation: (
        lineage: import('@kodax-ai/agent').KodaXSessionLineage,
      ) => import('@kodax-ai/agent').KodaXSessionLineage) => {
        if (id !== identity.sessionId) return false;
        const lineage = sessionData.lineage ?? createSessionLineage(sessionData.messages);
        const nextLineage = mutation(lineage);
        if (nextLineage !== lineage) sessionData = { ...sessionData, lineage: nextLineage };
        return true;
      },
      list: async () => [{
        id: identity.sessionId,
        title: sessionData.title,
        msgCount: sessionData.messages.length,
      }],
    };
    const notices: Array<{
      readonly sessionId?: string;
      readonly episodeId: string;
      readonly summaries: readonly string[];
      readonly proposalIds: readonly string[];
    }> = [];
    const options: KodaXOptions = {
      provider: 'anthropic',
      context: { executionCwd: cwd, configHome: home },
      session: { id: identity.sessionId, persistedByHost: true, storage },
      learningReviewer,
      events: { onMemoryNotice: (notice) => notices.push(notice) },
    };
    return { controller, digest, identity, learningStorePath, notices, options };
  }

  it('derives failedWithLesson qualification from a failed digest with a lesson (FEATURE_290 §3.3)', async () => {
    let reviewedInput: import('@kodax-ai/agent').UnifiedLearningReviewModelInput | undefined;
    const fixture = await failedLessonDrainFixture(async (input) => {
      reviewedInput = input;
      return {
        memoryPlan: {
          trigger: input.memory.trigger,
          createdAt: '2026-07-27T00:01:00.000Z',
          sourceRefs: input.memory.sourceRefs,
          candidateRefs: input.memory.candidateRefs,
          actions: [],
          warnings: [],
        },
      };
    });

    const result = await drainCodingMemoryReviewInbox(
      fixture.options,
      fixture.identity,
      fixture.controller,
      'session-visible',
    );

    expect(result).toMatchObject({ reviewed: 1, failed: 0 });
    expect(reviewedInput?.evidence.qualification.failedWithLesson).toBe(true);
  });

  it('keeps low-risk reviewer actions on failedWithLesson evidence in the human queue (FEATURE_290 §3.4)', async () => {
    const fixture = await failedLessonDrainFixture(async (input) => ({
      memoryPlan: {
        trigger: input.memory.trigger,
        createdAt: '2026-07-27T00:01:00.000Z',
        sourceRefs: input.memory.sourceRefs,
        candidateRefs: input.memory.candidateRefs,
        actions: [{
          action: 'write_memdir',
          targetRefIds: [],
          summary: 'Remember the failed verification lesson.',
          rationale: 'The episode failed with a sanitized lesson.',
          confidence: 'high',
          risk: 'low',
          requiresApproval: true,
          proposedBody: 'Inspect the failing verifier output before retrying.',
          claimKind: 'procedure',
          claimKey: 'project.verifier-failure-recovery',
        }],
        warnings: [],
      },
    }));

    const result = await drainCodingMemoryReviewInbox(
      fixture.options,
      fixture.identity,
      fixture.controller,
      'session-visible',
    );

    expect(result).toMatchObject({ reviewed: 1, failed: 0 });
    // Without the deterministic risk floor, a low-risk + high-confidence
    // action would auto-apply and emit a client notice (see the
    // auto-promotion test above); the floor keeps it pending instead.
    expect(fixture.notices).toEqual([]);
    const store = await readLearningProposalStore(fixture.learningStorePath);
    expect(store.proposals).toMatchObject([{ status: 'pending' }]);
  });

  it('keeps background review failures out of the ordinary conversation', async () => {
    const fixture = await failedLessonDrainFixture(async () => {
      throw new Error('reviewer unavailable');
    });

    const result = await drainCodingMemoryReviewInbox(
      fixture.options,
      fixture.identity,
      fixture.controller,
      'session-visible',
    );

    expect(result).toMatchObject({ reviewed: 0, failed: 1 });
    expect(fixture.notices).toEqual([]);
  });

  it('keeps turn-end review failures out of the ordinary conversation', async () => {
    const fixture = await failedLessonDrainFixture(async () => {
      throw new Error('reviewer unavailable');
    });

    const result = await drainCodingMemoryReviewInbox(
      fixture.options,
      fixture.identity,
      fixture.controller,
      '',
    );

    expect(result).toMatchObject({ reviewed: 0, failed: 1 });
    expect(fixture.notices).toEqual([]);
  });

  it('does not retry an unavailable preferred review again as backlog in the same drain', async () => {
    const reviewer = vi.fn(async () => {
      throw new EpisodeReviewFailure('provider_unavailable', 'learning review provider is not configured');
    });
    const fixture = await failedLessonDrainFixture(reviewer);
    const [job] = await listPendingEpisodeReviews(fixture.identity);
    if (job?.version !== 2) throw new Error('Expected a durable v2 review job');

    const result = await drainCodingMemoryReviewInbox(fixture.options, fixture.identity,
      fixture.controller, '', undefined, job.jobId);

    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ reviewed: 0, failed: 1 });
    const snapshot = await inspectEpisodeReviewJob(fixture.identity, job.jobId);
    expect(snapshot?.state).toMatchObject({
      status: 'pending', claimEpoch: 1, providerAttempts: 0,
    });
    expect(snapshot?.state.nextAttemptAt).toBeUndefined();
    expect(snapshot?.state.claimToken).toBeUndefined();
  });

  it('lets a successor drain recover a deferred preferred review without competing with an old retry', async () => {
    let releaseRetry: () => void;
    const retry = new Promise<void>(resolve => { releaseRetry = resolve; });
    const unavailable = vi.fn(async () => {
      if (unavailable.mock.calls.length > 1) await retry;
      throw new EpisodeReviewFailure('provider_unavailable', 'learning review provider is not configured');
    });
    const fixture = await failedLessonDrainFixture(unavailable);
    const [job] = await listPendingEpisodeReviews(fixture.identity);
    if (job?.version !== 2) throw new Error('Expected a durable v2 review job');
    const previous = drainCodingMemoryReviewInbox(fixture.options, fixture.identity,
      fixture.controller, '', undefined, job.jobId);
    const successor = vi.fn(async (input: Parameters<NonNullable<KodaXOptions['learningReviewer']>>[0]) => ({
      memoryPlan: { trigger: input.memory.trigger, createdAt: '2026-07-27T00:01:00.000Z',
        sourceRefs: input.memory.sourceRefs, candidateRefs: input.memory.candidateRefs,
        actions: [], warnings: [] },
    }));
    try {
      await expect.poll(async () => (await inspectEpisodeReviewJob(fixture.identity, job.jobId))?.state.lastError)
        .toBe('learning review provider is not configured');
      const recovered = await drainCodingMemoryReviewInbox({ ...fixture.options, learningReviewer: successor },
        fixture.identity, fixture.controller, 'successor-session');
      expect(successor).toHaveBeenCalledTimes(1);
      expect(recovered).toMatchObject({ reviewed: 1, failed: 0 });
      expect(await listPendingEpisodeReviews(fixture.identity)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ jobId: job.jobId }),
      ]));
      const data = await fixture.options.session!.storage!.load(fixture.identity.sessionId);
      expect(data?.lineage?.entries.filter(entry => entry.type === 'memory_review_receipt'
        && entry.jobId === job.jobId)).toHaveLength(1);
    } finally {
      releaseRetry!();
      await previous;
    }
  });
  it('passes the drain deadline through and reports deadline-released claims', async () => {
    let reviewCalls = 0;
    const fixture = await failedLessonDrainFixture(async (input) => {
      reviewCalls += 1;
      return {
        memoryPlan: {
          trigger: input.memory.trigger,
          createdAt: '2026-07-27T00:01:00.000Z',
          sourceRefs: input.memory.sourceRefs,
          candidateRefs: input.memory.candidateRefs,
          actions: [],
          warnings: [],
        },
      };
    });

    const result = await drainCodingMemoryReviewInbox(
      fixture.options,
      fixture.identity,
      fixture.controller,
      'session-visible',
      Date.now() - 1,
    );

    // The deadline already passed, so no job is claimed and the entry stays
    // pending for the next run.
    expect(result).toMatchObject({ reviewed: 0, failed: 0 });
    expect(result?.deferred).toBeGreaterThanOrEqual(1);
    expect(reviewCalls).toBe(0);
    expect(fixture.notices).toEqual([]);
    await expect(listPendingEpisodeReviews({
      configHome: fixture.identity.configHome!,
      tenantId: fixture.identity.tenantId,
    })).resolves.toHaveLength(1);
  });

  it('awaitLatestCodingMemoryReviewDrain resolves immediately when no drain has started', async () => {
    vi.resetModules();
    const fresh = await import('./memory-runtime.js');

    await expect(fresh.awaitLatestCodingMemoryReviewDrain(10_000)).resolves.toBeUndefined();
  });

  it('awaitLatestCodingMemoryReviewDrain bounds the wait and resolves once the drain completes', async () => {
    let releaseReview: (() => void) | undefined;
    const fixture = await failedLessonDrainFixture((input) => new Promise((resolve) => {
      releaseReview = () => resolve({
        memoryPlan: {
          trigger: input.memory.trigger,
          createdAt: '2026-07-27T00:01:00.000Z',
          sourceRefs: input.memory.sourceRefs,
          candidateRefs: input.memory.candidateRefs,
          actions: [],
          warnings: [],
        },
      });
    }));

    const drainPromise = drainCodingMemoryReviewInbox(
      fixture.options,
      fixture.identity,
      fixture.controller,
      'session-visible',
    );
    let drainSettled = false;
    void drainPromise.then(() => {
      drainSettled = true;
    });
    await vi.waitFor(() => expect(releaseReview).toBeDefined());

    // The reviewer never settles until released, so a short bounded await
    // returns while the drain is still in flight.
    await expect(awaitLatestCodingMemoryReviewDrain(30)).resolves.toBeUndefined();
    expect(drainSettled).toBe(false);

    releaseReview?.();
    await expect(awaitLatestCodingMemoryReviewDrain(2_000)).resolves.toBeUndefined();
    expect(drainSettled).toBe(true);
    await expect(drainPromise).resolves.toMatchObject({ reviewed: 1, failed: 0 });
  });
});
