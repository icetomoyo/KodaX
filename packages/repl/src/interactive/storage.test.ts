import os from 'os';
import path from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySessionCompaction, createSessionLineage } from '@kodax/coding';

describe('FileSessionStorage', () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-storage-'));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    vi.resetModules();
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    vi.resetModules();
    await rm(tempHome, { recursive: true, force: true });
  });

  it('round-trips extension state and extension records through JSONL session storage', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = path.resolve('C:/Works/GitWorks/KodaX').replace(/\\/g, '/');

    await storage.save('session-1', {
      messages: [{ role: 'user', content: 'hello persisted runtime' }],
      title: 'Persisted Runtime',
      gitRoot,
      uiHistory: [
        { type: 'user', text: 'hello persisted runtime' },
        { type: 'assistant', text: 'managed transcript survives resume' },
      ],
      extensionState: {
        'api:extension:C:/repo/extensions/sample.mjs': {
          phase: 'collecting',
          visits: 2,
        },
      },
      extensionRecords: [
        {
          id: 'record-1',
          extensionId: 'api:extension:C:/repo/extensions/sample.mjs',
          type: 'hydrate',
          ts: 1,
          data: { visits: 2 },
          dedupeKey: 'latest',
        },
      ],
      artifactLedger: [
        {
          id: 'artifact-1',
          kind: 'file_read',
          sourceTool: 'read',
          action: 'read',
          target: 'src/app.ts',
          displayTarget: 'src/app.ts',
          summary: 'Read src/app.ts',
          timestamp: '2026-04-03T00:00:00.000Z',
          metadata: { reason: 'resume' },
        },
      ],
    });

    await expect(storage.load('session-1')).resolves.toEqual({
      messages: [{ role: 'user', content: 'hello persisted runtime' }],
      title: 'Persisted Runtime',
      gitRoot,
      scope: 'user',
      uiHistory: [
        { type: 'user', text: 'hello persisted runtime' },
        { type: 'assistant', text: 'managed transcript survives resume' },
      ],
      errorMetadata: undefined,
      artifactLedger: [
        {
          id: 'artifact-1',
          kind: 'file_read',
          sourceTool: 'read',
          action: 'read',
          target: 'src/app.ts',
          displayTarget: 'src/app.ts',
          summary: 'Read src/app.ts',
          timestamp: '2026-04-03T00:00:00.000Z',
          metadata: { reason: 'resume' },
        },
      ],
      extensionState: {
        'api:extension:C:/repo/extensions/sample.mjs': {
          phase: 'collecting',
          visits: 2,
        },
      },
      extensionRecords: [
        {
          id: 'record-1',
          extensionId: 'api:extension:C:/repo/extensions/sample.mjs',
          type: 'hydrate',
          ts: 1,
          data: { visits: 2 },
          dedupeKey: 'latest',
        },
      ],
      lineage: expect.objectContaining({
        version: 2,
        entries: [
          expect.objectContaining({
            type: 'message',
            parentId: null,
            message: { role: 'user', content: 'hello persisted runtime' },
          }),
        ],
      }),
    });

    await expect(storage.list(gitRoot)).resolves.toEqual([
      {
        id: 'session-1',
        title: 'Persisted Runtime',
        msgCount: 1,
      },
    ]);
  });

  it('supports branch switching, checkpoint labels, and forking without losing prior history', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = path.resolve('C:/Works/GitWorks/KodaX').replace(/\\/g, '/');

    await storage.save('session-tree', {
      messages: [
        { role: 'user', content: 'root task' },
        { role: 'assistant', content: 'first pass' },
      ],
      title: 'Tree Session',
      gitRoot,
    });

    const initial = await storage.getLineage?.('session-tree');
    expect(initial?.entries).toHaveLength(2);
    const rootId = initial?.entries[0]?.id;
    expect(rootId).toBeTruthy();

    const rewound = await storage.setActiveEntry?.(
      'session-tree',
      rootId!,
      { summarizeCurrentBranch: true },
    );
    expect(rewound).toMatchObject({
      messages: [
        { role: 'user', content: 'root task' },
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('The following is a summary of a branch'),
        }),
      ],
    });

    await storage.save('session-tree', {
      messages: [
        ...(rewound?.messages ?? []),
        { role: 'user', content: 'root task follow-up' },
        { role: 'assistant', content: 'second pass' },
      ],
      title: 'Tree Session',
      gitRoot,
    });

    await storage.setLabel?.('session-tree', rootId!, 'checkpoint-a');

    const branched = await storage.getLineage?.('session-tree');
    expect(branched?.entries.filter((entry: { type: string }) => entry.type === 'label')).toHaveLength(1);
    expect(branched?.entries.filter((entry: { type: string }) => entry.type === 'branch_summary')).toHaveLength(1);
    expect(branched?.entries.filter((entry: { type: string }) => entry.type === 'message')).toHaveLength(4);

    const forked = await storage.fork?.('session-tree', 'checkpoint-a', { sessionId: 'forked-tree' });
    expect(forked?.sessionId).toBe('forked-tree');
    expect(forked?.data.messages).toEqual([
      { role: 'user', content: 'root task' },
    ]);

    await expect(storage.load('session-tree')).resolves.toMatchObject({
      messages: [
        { role: 'user', content: 'root task' },
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('The following is a summary of a branch'),
        }),
        { role: 'user', content: 'root task follow-up' },
        { role: 'assistant', content: 'second pass' },
      ],
    });
  });

  it('persists compaction anchors and artifact ledgers through JSONL round-trips', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = path.resolve('C:/Works/GitWorks/KodaX').replace(/\\/g, '/');

    const baseLineage = createSessionLineage([
      { role: 'user', content: 'root task' },
      { role: 'assistant', content: 'initial implementation' },
    ]);
    const lineage = applySessionCompaction(
      baseLineage,
      [
        { role: 'system', content: '[对话历史摘要]\n\nCompacted summary' },
        { role: 'assistant', content: 'continue from summary' },
      ],
      {
        summary: 'Compacted summary',
        tokensBefore: 1000,
        tokensAfter: 250,
        artifactLedgerId: 'ledger_abc123',
        reason: 'automatic_compaction',
        details: {
          readFiles: ['src/app.ts'],
          modifiedFiles: ['src/feature.ts'],
        },
        memorySeed: {
          objective: 'Continue from summary',
          constraints: ['Keep scope tight'],
          progress: {
            completed: ['Compacted old context'],
            inProgress: ['Resume latest implementation'],
            blockers: [],
          },
          keyDecisions: ['Keep the summary durable'],
          nextSteps: ['Continue the feature'],
          keyContext: ['src/app.ts'],
          importantTargets: ['src/feature.ts'],
          tombstones: [],
        },
      },
    );

    await storage.save('session-compacted', {
      messages: [
        { role: 'system', content: '[对话历史摘要]\n\nCompacted summary' },
        { role: 'assistant', content: 'continue from summary' },
      ],
      title: 'Compacted Session',
      gitRoot,
      lineage,
      artifactLedger: [
        {
          id: 'artifact-1',
          kind: 'file_modified',
          sourceTool: 'edit',
          action: 'edit',
          target: 'src/feature.ts',
          displayTarget: 'src/feature.ts',
          summary: 'Edited src/feature.ts',
          timestamp: '2026-04-03T00:00:00.000Z',
        },
      ],
    });

    await expect(storage.load('session-compacted')).resolves.toEqual(
      expect.objectContaining({
        title: 'Compacted Session',
        artifactLedger: [
          expect.objectContaining({
            id: 'artifact-1',
            kind: 'file_modified',
            target: 'src/feature.ts',
          }),
        ],
        lineage: expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({
              type: 'compaction',
              summary: 'Compacted summary',
              artifactLedgerId: 'ledger_abc123',
              firstKeptEntryId: expect.any(String),
              memorySeed: expect.objectContaining({
                objective: 'Continue from summary',
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it('hides managed-task worker sessions from default session listing and sorts by createdAt', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage();
    const gitRoot = path.resolve('C:/Works/GitWorks/KodaX').replace(/\\/g, '/');

    await storage.save('20260326_100000', {
      messages: [{ role: 'user', content: 'older user session' }],
      title: 'Older User',
      gitRoot,
      scope: 'user',
    });
    await storage.save('managed-task-worker-task-abc-evaluator', {
      messages: [{ role: 'assistant', content: 'internal evaluator session' }],
      title: 'Internal Worker',
      gitRoot,
      scope: 'managed-task-worker',
    });
    await storage.save('custom-user-session', {
      messages: [{ role: 'user', content: 'newer user session' }],
      title: 'Newer User',
      gitRoot,
      scope: 'user',
    });

    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    const olderPath = path.join(sessionsDir, '20260326_100000.jsonl');
    const newerPath = path.join(sessionsDir, 'custom-user-session.jsonl');
    const olderContent = await readFile(olderPath, 'utf8');
    const newerContent = await readFile(newerPath, 'utf8');
    const newerCreatedAt = '2026-03-26T11:00:00.000Z';
    const olderCreatedAt = '2026-03-26T10:00:00.000Z';

    await Promise.all([
      writeFile(
        olderPath,
        olderContent.replace(/\"createdAt\":\"[^\"]+\"/, `"createdAt":"${olderCreatedAt}"`),
        'utf8',
      ),
      writeFile(
        newerPath,
        newerContent.replace(/\"createdAt\":\"[^\"]+\"/, `"createdAt":"${newerCreatedAt}"`),
        'utf8',
      ),
    ]);

    await expect(storage.list(gitRoot)).resolves.toEqual([
      {
        id: 'custom-user-session',
        title: 'Newer User',
        msgCount: 1,
      },
      {
        id: '20260326_100000',
        title: 'Older User',
        msgCount: 1,
      },
    ]);
  });
});
