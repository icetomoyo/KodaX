import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readLearningProposalStore,
  updateLearningProposalStatus,
  upsertLearningProposal,
  type MemoryLearningHandoff,
} from './index.js';

const tempDirs: string[] = [];

function isMutableRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function memoryProposal(proposalId: string): MemoryLearningHandoff {
  return {
    destination: 'memdir_handoff',
    proposalId,
    origin: 'background_learning',
    userLabel: 'context_note',
    memoryKind: 'project',
    body: 'Run focused tests before release.',
    metadata: {
      writeOrigin: 'background_learning',
      executionContext: 'primary',
      sessionId: 'session-store',
      sourceRefs: [`turn:${proposalId}`],
      completedTurn: true,
    },
  };
}

describe('learning proposal store', () => {
  it('serializes concurrent proposal upserts without losing entries', async () => {
    const dir = await createTempDir('kodax-learning-store-concurrent-');
    const storePath = join(dir, 'proposals.json');
    const proposals = ['p-concurrent-a', 'p-concurrent-b'].map((proposalId) =>
      memoryProposal(proposalId));
    await Promise.all(proposals.map((proposal) => upsertLearningProposal(storePath, proposal)));

    expect((await readLearningProposalStore(storePath)).proposals.map((entry) => entry.proposalId).sort())
      .toEqual(['p-concurrent-a', 'p-concurrent-b']);
  });

  it('does not remove a successor lock when the current lock owner finishes', async () => {
    const dir = await createTempDir('kodax-learning-store-lock-owner-');
    const storePath = join(dir, 'proposals.json');
    const lockPath = `${storePath}.lock`;
    const successorLock = `${process.pid} 11111111-1111-4111-8111-111111111111\n`;
    const proposal = memoryProposal('p-lock-owner');

    await upsertLearningProposal(storePath, proposal, {
      now: () => {
        writeFileSync(lockPath, successorLock, 'utf8');
        return '2026-07-12T00:00:00.000Z';
      },
    });

    await expect(readFile(lockPath, 'utf8')).resolves.toBe(successorLock);
    await rm(lockPath, { force: true });
  });

  it('reclaims a malformed stale proposal-store lock without manual cleanup', async () => {
    const dir = await createTempDir('kodax-learning-store-malformed-lock-');
    const storePath = join(dir, 'proposals.json');
    const lockPath = `${storePath}.lock`;
    await writeFile(lockPath, 'corrupt owner\n', 'utf8');
    const stale = new Date(Date.now() - 31_000);
    await utimes(lockPath, stale, stale);
    const proposal = memoryProposal('p-malformed-lock');

    await expect(upsertLearningProposal(storePath, proposal))
      .resolves.toMatchObject({ proposalId: 'p-malformed-lock' });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readLearningProposalStore(storePath)).proposals
      .map((entry) => entry.proposalId)).toEqual(['p-malformed-lock']);
  });

  it('stores reviewable proposals and records rejection feedback', async () => {
    const dir = await createTempDir('kodax-learning-store-');
    const storePath = join(dir, 'proposals.json');
    const proposal = memoryProposal('p-store');

    const stored = await upsertLearningProposal(storePath, proposal, {
      now: () => '2026-06-21T00:00:00.000Z',
    });
    expect(stored.status).toBe('pending');

    const rejected = await updateLearningProposalStatus(storePath, 'p-store', 'rejected', {
      rejectedReason: 'too broad',
      now: () => '2026-06-21T00:01:00.000Z',
    });

    const read = await readLearningProposalStore(storePath);
    expect(rejected.rejectedReason).toBe('too broad');
    expect(read.warnings).toEqual([]);
    expect(read.proposals).toHaveLength(1);
    expect(read.proposals[0]).toMatchObject({
      proposalId: 'p-store',
      status: 'rejected',
      rejectedReason: 'too broad',
    });
  });

  it('clears rejected feedback when a proposal is later approved', async () => {
    const dir = await createTempDir('kodax-learning-store-clear-');
    const storePath = join(dir, 'proposals.json');
    const proposal = memoryProposal('p-clear');

    await upsertLearningProposal(storePath, proposal);
    await updateLearningProposalStatus(storePath, 'p-clear', 'rejected', {
      rejectedReason: 'too broad',
    });
    const approved = await updateLearningProposalStatus(storePath, 'p-clear', 'approved');

    expect(approved.status).toBe('approved');
    expect(approved.rejectedReason).toBeUndefined();
  });

  it('persists application metadata when a proposal is approved', async () => {
    const dir = await createTempDir('kodax-learning-store-applied-');
    const storePath = join(dir, 'proposals.json');
    const proposal = memoryProposal('p-applied');

    await upsertLearningProposal(storePath, proposal);
    await updateLearningProposalStatus(storePath, 'p-applied', 'approved', {
      appliedAt: '2026-06-21T00:02:00.000Z',
      appliedChangedPaths: ['SKILL.md'],
      appliedSnapshotPath: join(dir, 'snapshot'),
      now: () => '2026-06-21T00:02:00.000Z',
    });

    const read = await readLearningProposalStore(storePath);
    expect(read.warnings).toEqual([]);
    expect(read.proposals[0]).toMatchObject({
      status: 'approved',
      appliedAt: '2026-06-21T00:02:00.000Z',
      appliedChangedPaths: ['SKILL.md'],
      appliedSnapshotPath: join(dir, 'snapshot'),
    });
  });

  it('degrades corrupt stores to warnings without returning proposals', async () => {
    const dir = await createTempDir('kodax-learning-corrupt-');
    const storePath = join(dir, 'proposals.json');
    await writeFile(storePath, '{not-json', 'utf8');

    const read = await readLearningProposalStore(storePath);

    expect(read.proposals).toEqual([]);
    expect(read.warnings[0]).toContain('not valid JSON');
  });

  it.each([
    ['reviewRationale', 42],
    ['reviewRisk', 'critical'],
  ])('rejects invalid persisted memory %s metadata', async (field, invalidValue) => {
    const dir = await createTempDir(`kodax-learning-memory-${field}-`);
    const storePath = join(dir, 'proposals.json');
    const proposal = memoryProposal(`p-memory-${field}`);
    await upsertLearningProposal(storePath, proposal);
    const document: unknown = JSON.parse(await readFile(storePath, 'utf8'));
    if (!isMutableRecord(document) || !Array.isArray(document.proposals)
      || !isMutableRecord(document.proposals[0])
      || !isMutableRecord(document.proposals[0].proposal)
      || !isMutableRecord(document.proposals[0].proposal.metadata)) {
      throw new Error('expected stored memory proposal');
    }
    document.proposals[0].proposal.metadata[field] = invalidValue;
    await writeFile(storePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

    const read = await readLearningProposalStore(storePath);

    expect(read.proposals).toEqual([]);
    expect(read.warnings).toEqual([
      `proposal entry p-memory-${field} has invalid proposal payload`,
    ]);
  });

  it.each([
    ['approvedAt', 123],
    ['approvalPolicyId', 123],
    ['approvalPolicyReason', 123],
    ['approvalExpectedFingerprints', []],
    ['approvalResultingFingerprints', []],
  ])('warns and refuses to overwrite an invalid %s field', async (field, invalidValue) => {
    const dir = await createTempDir(`kodax-learning-corrupt-${field}-`);
    const storePath = join(dir, 'proposals.json');
    const proposal = memoryProposal(`p-corrupt-${field}`);
    await upsertLearningProposal(storePath, proposal);
    await updateLearningProposalStatus(storePath, proposal.proposalId, 'approved', {
      approvedBy: 'host',
      approvedAt: '2026-07-12T00:00:00.000Z',
      approvalPolicyId: 'policy-v1',
      approvalPolicyReason: 'verified',
      approvalExpectedFingerprints: { before: 'sha256:before' },
      approvalResultingFingerprints: { after: 'sha256:after' },
    });
    const document: unknown = JSON.parse(await readFile(storePath, 'utf8'));
    if (!isMutableRecord(document) || !Array.isArray(document.proposals)
      || !isMutableRecord(document.proposals[0])) {
      throw new Error('test setup expected a stored proposal document');
    }
    document.proposals[0][field] = invalidValue;
    await writeFile(storePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    const corruptBytes = await readFile(storePath, 'utf8');

    const read = await readLearningProposalStore(storePath);

    expect(read.proposals).toEqual([]);
    expect(read.warnings).toContain(`proposal entry ${proposal.proposalId} has invalid ${field}`);
    await expect(upsertLearningProposal(storePath, proposal)).rejects.toThrow(/refusing to write corrupt/);
    await expect(readFile(storePath, 'utf8')).resolves.toBe(corruptBytes);
  });

  it('rejects trace-only and unknown destinations as reviewable proposals', async () => {
    const dir = await createTempDir('kodax-learning-invalid-store-');
    const storePath = join(dir, 'proposals.json');
    await writeFile(
      storePath,
      `${JSON.stringify({
        version: 1,
        proposals: [
          {
            proposalId: 'p-trace',
            status: 'pending',
            createdAt: '2026-06-21T00:00:00.000Z',
            updatedAt: '2026-06-21T00:00:00.000Z',
            proposal: {
              destination: 'trace_only',
              proposalId: 'p-trace',
              userLabel: 'trace_only',
              reason: 'low confidence',
              sourceTraceIds: ['turn:6'],
            },
          },
          {
            proposalId: 'p-unknown',
            status: 'pending',
            createdAt: '2026-06-21T00:00:00.000Z',
            updatedAt: '2026-06-21T00:00:00.000Z',
            proposal: {
              destination: 'unknown_carrier',
              proposalId: 'p-unknown',
            },
          },
          {
            proposalId: 'p-malformed-workflow',
            status: 'pending',
            createdAt: '2026-06-21T00:00:00.000Z',
            updatedAt: '2026-06-21T00:00:00.000Z',
            proposal: {
              destination: 'workflow_handoff',
              proposalId: 'p-malformed-workflow',
              origin: 'background_learning',
              userLabel: 'runnable_workflow',
            },
          },
          {
            proposalId: 'p-wrapper',
            status: 'pending',
            createdAt: '2026-06-21T00:00:00.000Z',
            updatedAt: '2026-06-21T00:00:00.000Z',
            proposal: {
              destination: 'skill_patch',
              proposalId: 'p-inner',
              origin: 'background_learning',
              userLabel: 'method_guide',
              skillName: 'release-notes',
              whyDurable: 'The same checklist was reused across completed sessions.',
              trigger: 'When release notes are requested.',
              changeSummary: 'Add the checklist.',
              sourceTraceIds: ['turn:mismatch'],
              confidence: 0.5,
            },
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    );

    const read = await readLearningProposalStore(storePath);

    expect(read.proposals).toEqual([]);
    expect(read.warnings).toEqual([
      'proposal entry p-trace has invalid proposal payload',
      'proposal entry p-unknown has invalid proposal payload',
      'proposal entry p-malformed-workflow has invalid proposal payload',
      'proposal entry p-wrapper has mismatched proposal payload id',
    ]);
  });
});
