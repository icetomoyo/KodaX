import os from 'os';
import path from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    });

    await expect(storage.load('session-1')).resolves.toEqual({
      messages: [{ role: 'user', content: 'hello persisted runtime' }],
      title: 'Persisted Runtime',
      gitRoot,
      errorMetadata: undefined,
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
});
