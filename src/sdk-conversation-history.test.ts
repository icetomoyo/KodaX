import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentActorSnapshot,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionEntry,
  KodaXSessionLineage,
} from '@kodax-ai/agent';
import { createSessionManager, FileSessionStorage } from '@kodax-ai/repl';

import * as sdkAgent from './sdk-agent.js';
import { createKodaXRuntime, type RuntimeConversationHistorySlice } from './sdk-runtime.js';

const timestamp = '2026-08-01T00:00:00.000Z';

function acceptedActorSnapshot(): AgentActorSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    maxConcurrentThreads: 4,
    actors: [{
      path: '/root',
      taskName: 'root',
      kind: 'native',
      state: 'running',
      capabilities: {
        tools: ['*'],
        filesystem: 'write',
        network: true,
        providers: ['*'],
        canAskUser: true,
      },
      turnIds: ['accepted-turn'],
      currentTurnId: 'accepted-turn',
      mailboxCursor: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
    }],
    turns: [{
      turnId: 'accepted-turn',
      actorPath: '/root',
      sequence: 1,
      state: 'accepted',
      objective: 'Wait for canonical conversation persistence.',
      forkTurns: 'none',
      createdAt: timestamp,
      progress: [],
      revision: 1,
    }],
    mailboxes: { '/root': [] },
    events: [],
  };
}

function messageEntry(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  content: string,
  identity: { logicalId?: string; sourceEntryId?: string } = {},
): Extract<KodaXSessionEntry, { type: 'message' }> {
  return {
    type: 'message',
    id,
    parentId,
    timestamp,
    logicalId: identity.logicalId ?? id,
    ...(identity.sourceEntryId !== undefined
      ? { sourceEntryId: identity.sourceEntryId }
      : {}),
    message: { role, content },
  };
}

async function removeConversationPageCaches(sessionsDir: string): Promise<void> {
  for (const directory of await readdir(sessionsDir, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const projectDir = path.join(sessionsDir, directory.name);
    for (const file of await readdir(projectDir)) {
      if (!file.includes('.conversation-cache.')) continue;
      await rm(path.join(projectDir, file), { force: true });
    }
  }
}

describe('Runtime conversation history', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })));
  });

  async function fixture(
    finalAnswer = 'third answer',
    isolation: 'inline' | 'worker' = 'inline',
    legacyAmbiguous = false,
  ) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-conversation-'));
    tempRoots.push(root);
    const sessionsDir = path.join(root, 'sessions');
    const sessionId = 'conversation-runtime-source';
    const entries: KodaXSessionEntry[] = legacyAmbiguous
      ? [
          messageEntry('u1', null, 'user', 'first request'),
          messageEntry('a1', 'u1', 'assistant', 'first answer'),
          {
            type: 'compaction',
            id: 'compact',
            parentId: null,
            timestamp,
            logicalId: 'compact',
            summary: 'summary',
          },
          messageEntry('legacy-u1-copy', 'compact', 'user', 'first request'),
          messageEntry('legacy-a1-copy', 'legacy-u1-copy', 'assistant', 'first answer'),
          messageEntry('u3', 'legacy-a1-copy', 'user', 'third request'),
        ]
      : [
          messageEntry('u1', null, 'user', 'first request'),
          messageEntry('a1', 'u1', 'assistant', 'first answer'),
          messageEntry('u2', 'a1', 'user', 'second request'),
          messageEntry('a2', 'u2', 'assistant', 'second answer'),
          {
            type: 'compaction',
            id: 'compact',
            parentId: null,
            timestamp,
            logicalId: 'compact',
            summary: 'summary',
            firstKeptEntryId: 'u2-copy',
          },
          messageEntry('u2-copy', 'compact', 'user', 'second request', {
            logicalId: 'u2',
            sourceEntryId: 'u2',
          }),
          messageEntry('a2-copy', 'u2-copy', 'assistant', 'second answer', {
            logicalId: 'a2',
            sourceEntryId: 'a2',
          }),
          messageEntry('u3', 'a2-copy', 'user', 'third request'),
          messageEntry('a3', 'u3', 'assistant', finalAnswer),
        ];
    const lineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: legacyAmbiguous ? 'u3' : 'a3',
      entries,
    };
    const manager = createSessionManager({ sessionsDir });
    await manager.storage.save(sessionId, {
      title: 'Conversation Runtime',
      gitRoot: root,
      scope: 'user',
      lineage,
      messages: legacyAmbiguous
        ? [
            { role: 'system', content: '[summary]' },
            { role: 'user', content: 'first request' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'third request' },
          ]
        : [
            { role: 'system', content: '[summary]' },
            { role: 'user', content: 'second request' },
            { role: 'assistant', content: 'second answer' },
            { role: 'user', content: 'third request' },
            { role: 'assistant', content: finalAnswer },
          ],
    });
    const runtime = await createKodaXRuntime({
      homeDir: root,
      sessionsDir,
      ...(isolation === 'worker' ? { isolation } : {}),
    });
    return { manager, root, runtime, sessionId };
  }

  it.each([
    {
      name: 'an empty v2 Session',
      sessionId: 'empty-v2-conversation',
      actorSnapshot: undefined,
    },
    {
      name: 'an accepted Run before canonical history exists',
      sessionId: 'accepted-empty-conversation',
      actorSnapshot: acceptedActorSnapshot(),
    },
  ])('keeps $name resolved and identical across direct and paged reads', async ({
    sessionId,
    actorSnapshot,
  }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-empty-conversation-'));
    tempRoots.push(root);
    const sessionsDir = path.join(root, 'sessions');
    const manager = createSessionManager({ sessionsDir });
    await manager.storage.save(sessionId, {
      title: 'Empty persisted conversation',
      gitRoot: root,
      scope: 'user',
      messages: [],
      lineage: { version: 2, activeEntryId: null, entries: [] },
      ...(actorSnapshot === undefined ? {} : { actorSnapshot }),
    });
    const standalone = await manager.readConversationHistory(sessionId);
    const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir });
    try {
      const direct = await runtime.sessions.conversation(sessionId);
      const page = await runtime.sessions.conversationPage({ sessionId, limit: 20 });

      expect(standalone).toMatchObject({
        status: 'resolved',
        entries: [],
        issues: [],
      });
      expect(direct).toMatchObject({
        sourceRevision: standalone?.sourceRevision,
        status: 'resolved',
        entries: [],
        issues: [],
      });
      expect(page).toMatchObject({
        revision: direct?.revision,
        sourceRevision: direct?.sourceRevision,
        status: direct?.status,
        entries: [],
        issues: direct?.issues,
      });
    } finally {
      await runtime.close();
    }
  });

  it('retains persisted orphan records as partial when their lineage cannot be recovered', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-orphan-conversation-'));
    tempRoots.push(root);
    const sessionsDir = path.join(root, 'sessions');
    const sessionId = 'orphaned-conversation-record';
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), `${JSON.stringify({
      _type: 'meta',
      id: sessionId,
      title: 'Orphaned persisted conversation',
      gitRoot: root,
      createdAt: timestamp,
      scope: 'user',
      activeMessageCount: 0,
    })}\n`, 'utf8');
    await writeFile(
      path.join(sessionsDir, `${sessionId}.islands.jsonl`),
      `${JSON.stringify({
        _type: 'archived_entry',
        archiveBatchId: 'orphaned-record-batch',
        entry: messageEntry(
          'orphaned-message',
          'missing-parent',
          'assistant',
          'recoverable body without a recoverable lineage',
        ),
      })}\n`,
      'utf8',
    );
    const manager = createSessionManager({ sessionsDir });
    const standalone = await manager.readConversationHistory(sessionId);
    const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir });
    try {
      const direct = await runtime.sessions.conversation(sessionId);
      const page = await runtime.sessions.conversationPage({ sessionId, limit: 20 });

      expect(standalone).toMatchObject({
        status: 'partial',
        entries: [{
          boundaryId: 'orphaned-message',
          message: { content: 'recoverable body without a recoverable lineage' },
        }],
        issues: [expect.objectContaining({ code: 'active_entry_missing' })],
      });
      expect(direct).toMatchObject({
        sourceRevision: standalone?.sourceRevision,
        status: standalone?.status,
        entries: standalone?.entries,
        issues: standalone?.issues,
      });
      expect(page).toMatchObject({
        revision: direct?.revision,
        sourceRevision: direct?.sourceRevision,
        status: direct?.status,
        issues: direct?.issues,
      });
      expect(page?.entries.map((entry) => entry.entry)).toEqual(direct?.entries);
    } finally {
      await runtime.close();
    }
  });

  it('keeps storage.load results mutable through the public SDK and persists prefix edits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-mutable-session-'));
    tempRoots.push(root);
    const sessionsDir = path.join(root, 'sessions');
    const sessionId = 'public-mutable-session';
    const entries = [
      messageEntry('mutable-u1', null, 'user', 'original request'),
      messageEntry('mutable-a1', 'mutable-u1', 'assistant', 'original answer'),
    ];
    const artifactLedger: KodaXSessionArtifactLedgerEntry[] = [{
      id: 'mutable-artifact',
      kind: 'file_read',
      target: 'original.ts',
      timestamp,
    }];
    const manager = createSessionManager({ sessionsDir });
    await manager.storage.save(sessionId, {
      title: 'Public mutable Session',
      gitRoot: root,
      scope: 'user',
      lineage: { version: 2, activeEntryId: 'mutable-a1', entries },
      artifactLedger,
      messages: entries.map((entry) => entry.type === 'message'
        ? entry.message
        : { role: 'user' as const, content: '' }),
    });

    const loaded = await manager.storage.load(sessionId);
    if (loaded?.lineage === undefined || loaded.artifactLedger === undefined) {
      throw new Error('expected public storage Session data');
    }
    expect(() => structuredClone(loaded)).not.toThrow();
    expect(Object.getOwnPropertyDescriptor(loaded.lineage.entries, '0')).toMatchObject({
      configurable: true,
      writable: true,
    });
    expect(Object.getOwnPropertyDescriptor(loaded.artifactLedger, '0')).toMatchObject({
      configurable: true,
      writable: true,
    });

    const rewrittenRoot = messageEntry('mutable-u1', null, 'user', 'rewritten request');
    loaded.lineage.entries[0] = rewrittenRoot;
    loaded.artifactLedger[0] = {
      ...loaded.artifactLedger[0]!,
      target: 'rewritten.ts',
    };
    const nextMessages = [
      rewrittenRoot.message,
      entries[1]!.type === 'message'
        ? entries[1]!.message
        : { role: 'assistant' as const, content: '' },
      { role: 'user' as const, content: 'new tail' },
    ];
    const nextLineage = sdkAgent.createSessionLineage(nextMessages, loaded.lineage);

    await manager.storage.appendSessionDelta(sessionId, {
      ...loaded,
      messages: nextMessages,
      lineage: nextLineage,
    });

    const reloaded = await new FileSessionStorage({ sessionsDir }).load(sessionId);
    expect(reloaded?.lineage?.entries[0]).toMatchObject({
      id: rewrittenRoot.id,
      message: { content: 'rewritten request' },
    });
    expect(reloaded?.artifactLedger?.[0]).toMatchObject({
      id: 'mutable-artifact',
      target: 'rewritten.ts',
    });
    expect(reloaded?.messages.at(-1)).toMatchObject({ content: 'new tail' });
  });

  it('persists in-place loaded entry and artifact edits through the public SDK', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-nested-session-'));
    tempRoots.push(root);
    const sessionsDir = path.join(root, 'sessions');
    const sessionId = 'public-nested-session';
    const baseMessages = [{ role: 'user' as const, content: 'nested before' }];
    const manager = createSessionManager({ sessionsDir });
    await manager.storage.save(sessionId, {
      title: 'Public nested Session',
      gitRoot: root,
      scope: 'user',
      lineage: sdkAgent.createSessionLineage(baseMessages),
      artifactLedger: [{
        id: 'nested-artifact',
        kind: 'file_read',
        target: 'nested-before.ts',
        timestamp,
      }],
      messages: baseMessages,
    });

    const loaded = await manager.storage.load(sessionId);
    const loadedEntry = loaded?.lineage?.entries[0];
    const loadedArtifact = loaded?.artifactLedger?.[0];
    if (
      loaded?.lineage === undefined
      || loadedEntry?.type !== 'message'
      || loadedArtifact === undefined
    ) {
      throw new Error('expected mutable public Session prefix');
    }
    loadedEntry.message.content = 'nested after';
    loadedArtifact.target = 'nested-after.ts';
    const nextMessages = [
      loadedEntry.message,
      { role: 'assistant' as const, content: 'nested tail' },
    ];

    const nextLineage = sdkAgent.createSessionLineage(nextMessages, loaded.lineage);
    const nextEntry = nextLineage.entries[0];
    if (nextEntry?.type !== 'message') throw new Error('expected helper lineage entry');
    nextEntry.message.content = 'nested after helper';
    loadedArtifact.target = 'nested-after-helper.ts';

    await manager.storage.appendSessionDelta(sessionId, {
      ...loaded,
      messages: nextMessages,
      lineage: nextLineage,
    });

    const reloaded = await new FileSessionStorage({ sessionsDir }).load(sessionId);
    expect(reloaded?.lineage?.entries[0]).toMatchObject({
      message: { content: 'nested after helper' },
    });
    expect(reloaded?.artifactLedger?.[0]).toMatchObject({
      target: 'nested-after-helper.ts',
    });
    expect(reloaded?.messages.at(-1)).toMatchObject({ content: 'nested tail' });
  });

  it('does not expose append-prefix trust declarations from the public agent SDK', () => {
    expect('inheritSessionAppendPrefix' in sdkAgent).toBe(false);
    expect('captureSessionAppendPrefix' in sdkAgent).toBe(false);
    expect('hasSessionAppendPrefix' in sdkAgent).toBe(false);
  });

  it('does not publish an importable append-prefix trust subpath', async () => {
    const packageJson = JSON.parse(await readFile(
      path.join(process.cwd(), 'packages', 'agent', 'package.json'),
      'utf8',
    )) as { exports?: Record<string, unknown> };
    expect(packageJson.exports).not.toHaveProperty('./internal/session-append-prefix');
    const probe = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      "import('@kodax-ai/agent/internal/session-append-prefix').then(() => process.exit(2)).catch((error) => process.exit(error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' ? 0 : 3))",
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(probe.status, probe.stderr).toBe(0);
  });

  it('returns the same resolved order from direct and immutable paged reads', async () => {
    const { runtime, sessionId } = await fixture();
    try {
      const direct = await runtime.sessions.conversation(sessionId);
      if (direct === null) throw new Error('conversation history missing');
      const reconstructed: RuntimeConversationHistorySlice['entries'][number][] = [];
      let cursor: string | undefined;
      do {
        const page = await runtime.sessions.conversationPage({
          sessionId,
          ...(cursor !== undefined ? { cursor } : {}),
          limit: 2,
        });
        if (page === null) throw new Error('conversation page missing');
        expect(page.revision).toBe(direct.revision);
        expect(page.sourceRevision).toBe(direct.sourceRevision);
        expect(page.status).toBe('resolved');
        reconstructed.unshift(...page.entries);
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      expect(reconstructed.map((item) => item.entry)).toEqual(direct.entries);
      expect(direct.entries.map((entry) => entry.message.content)).toEqual([
        'first request',
        'first answer',
        'second request',
        'second answer',
        'third request',
        'third answer',
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('serves a prepared long-session tail without a full capture and resyncs after mutation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-conversation-page-'));
    tempRoots.push(root);
    const sessionsDir = path.join(root, 'sessions');
    const sessionId = 'bounded-conversation-page';
    const entries = Array.from({ length: 2_000 }, (_, index) => messageEntry(
      `entry-${index}`,
      index === 0 ? null : `entry-${index - 1}`,
      index % 2 === 0 ? 'user' : 'assistant',
      `message-${index}`,
    ));
    const manager = createSessionManager({ sessionsDir });
    await manager.storage.save(sessionId, {
      title: 'Bounded Conversation Page',
      gitRoot: root,
      scope: 'user',
      runtimeInfo: { surface: 'repl' },
      lineage: {
        version: 2,
        activeEntryId: entries.at(-1)!.id,
        entries,
      },
      messages: entries.map((entry) => entry.type === 'message'
        ? entry.message
        : { role: 'user' as const, content: '' }),
    });
    const fullCapture = vi.spyOn(FileSessionStorage.prototype, 'readFullSnapshot');
    const peek = vi.spyOn(FileSessionStorage.prototype, 'peek');
    const runtime = await createKodaXRuntime({
      homeDir: root,
      sessionsDir,
      sharedDaemonHost: true,
    });
    peek.mockClear();
    try {
      const first = await runtime.sessions.conversationPage({ sessionId, limit: 5 });
      expect(first?.entries.map((item) => item.entry?.message.content)).toEqual([
        'message-1995',
        'message-1996',
        'message-1997',
        'message-1998',
        'message-1999',
      ]);
      expect(first?.nextCursor).toEqual(expect.any(String));
      expect(fullCapture).not.toHaveBeenCalled();
      expect(peek).not.toHaveBeenCalled();
      const second = await runtime.sessions.conversationPage({
        sessionId,
        cursor: first!.nextCursor,
        limit: 5,
      });
      expect(second?.entries.map((item) => item.entry?.message.content)).toEqual([
        'message-1990',
        'message-1991',
        'message-1992',
        'message-1993',
        'message-1994',
      ]);
      expect(fullCapture).not.toHaveBeenCalled();
      expect(peek).not.toHaveBeenCalled();

      const updatedEntries = [
        ...entries,
        messageEntry('entry-2000', 'entry-1999', 'user', 'message-2000'),
      ];
      const baseline = await manager.storage.prepareSessionAppend(sessionId);
      if (baseline === null) throw new Error('prepared append boundary missing');
      await manager.storage.appendPreparedSessionTail(sessionId, {
        baseline,
        title: 'Bounded Conversation Page',
        scope: 'user',
        activeEntryId: 'entry-2000',
        lineageEntries: updatedEntries.slice(baseline.lineageCount),
      });
      await expect(runtime.sessions.conversationPage({
        sessionId,
        cursor: first!.nextCursor,
        limit: 5,
      })).rejects.toMatchObject({ code: 'resync_required' });
      const refreshed = await runtime.sessions.conversationPage({ sessionId, limit: 2 });
      expect(refreshed?.entries.map((item) => item.entry?.message.content)).toEqual([
        'message-1999',
        'message-2000',
      ]);
      expect(fullCapture).not.toHaveBeenCalled();
    } finally {
      peek.mockRestore();
      fullCapture.mockRestore();
      await runtime.close();
    }
  });

  it.each(['prepared', 'fallback'])('pages legacy metadata over 64 KiB on cold start and restart (%s)', async (mode) => {
    if (mode === 'fallback') {
      vi.spyOn(FileSessionStorage.prototype, 'prepareConversationPageCache')
        .mockRejectedValue(new Error('cache storage unavailable'));
      vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    }
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-large-metadata-'));
    tempRoots.push(root);
    const sessionsDir = path.join(root, 'sessions');
    const sessionId = 'large-metadata-history';
    const baseSnapshot = acceptedActorSnapshot();
    const actorSnapshot: AgentActorSnapshot = {
      ...baseSnapshot,
      turns: baseSnapshot.turns.map((turn) => ({
        ...turn, objective: '保留完整任务上下文🙂'.repeat(8_000),
      })),
    };
    const metadata = JSON.stringify({
      _type: 'meta', id: sessionId, title: 'Large legacy metadata',
      createdAt: timestamp, scope: 'user', actorSnapshot,
      runtimeInfo: { surface: 'repl' }, activeMessageCount: 4,
    });
    expect(Buffer.byteLength(metadata)).toBeGreaterThan(64 * 1024);
    const messages = ['first request', 'first answer', 'second request', 'second answer']
      .map((content, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content }));
    const source = [metadata, ...messages.map((message) => JSON.stringify(message)), ''].join('\n');
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    await writeFile(sessionPath, source, 'utf8');

    for (let startup = 0; startup < 2; startup += 1) {
      const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir });
      try {
        const first = await runtime.sessions.conversationPage({ sessionId, limit: 2 });
        expect(first?.entries.map((item) => item.entry?.message.content)).toEqual([
          'second request', 'second answer',
        ]);
        if (first?.nextCursor === undefined) throw new Error('continuation cursor missing');
        const second = await runtime.sessions.conversationPage({
          sessionId, limit: 2, cursor: first.nextCursor,
        });
        expect(second?.entries.map((item) => item.entry?.message.content)).toEqual([
          'first request', 'first answer',
        ]);
        expect(second?.revision).toBe(first.revision);
        expect(second?.nextCursor).toBeUndefined();
      } finally {
        await runtime.close();
      }
      expect(await readFile(sessionPath, 'utf8')).toBe(source);
    }
  });

  it('upgrades a cache-less existing session once and reuses its bounded pages', async () => {
    const { root, runtime, sessionId } = await fixture();
    const sessionsDir = path.join(root, 'sessions');
    await removeConversationPageCaches(sessionsDir);
    const fullCapture = vi.spyOn(FileSessionStorage.prototype, 'readFullSnapshot');
    try {
      await expect(runtime.sessions.conversationPage({ sessionId, limit: 2 }))
        .resolves.toMatchObject({ entries: expect.any(Array) });
      expect(fullCapture).toHaveBeenCalledTimes(1);
      fullCapture.mockClear();

      await expect(runtime.sessions.conversationPage({ sessionId, limit: 2 }))
        .resolves.toMatchObject({ entries: expect.any(Array) });
      expect(fullCapture).not.toHaveBeenCalled();
    } finally {
      fullCapture.mockRestore();
      await runtime.close();
    }
  });

  it('invalidates a fallback conversation page cursor after the Session changes', async () => {
    const { manager, root, runtime, sessionId } = await fixture();
    await removeConversationPageCaches(path.join(root, 'sessions'));
    const prepare = vi.spyOn(
      FileSessionStorage.prototype,
      'prepareConversationPageCache',
    ).mockRejectedValue(new Error('forced cache preparation failure'));
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const first = await runtime.sessions.conversationPage({ sessionId, limit: 2 });
      if (first?.nextCursor === undefined) throw new Error('fallback page cursor missing');
      const current = await manager.storage.load(sessionId);
      if (current?.lineage === undefined) throw new Error('Session lineage missing');
      const appended = messageEntry('a4', current.lineage.activeEntryId, 'assistant', 'changed');
      await manager.storage.appendSessionDelta(sessionId, {
        ...current,
        lineage: {
          ...current.lineage,
          activeEntryId: appended.id,
          entries: [...current.lineage.entries, appended],
        },
        messages: [...current.messages, appended.message],
      });

      await expect(runtime.sessions.conversationPage({
        sessionId,
        cursor: first.nextCursor,
        limit: 2,
      })).rejects.toMatchObject({ code: 'resync_required' });
      expect(prepare).toHaveBeenCalled();
      expect(warning).toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it('invalidates a fallback oversized-entry chunk after the Session changes', async () => {
    const { manager, root, runtime, sessionId } = await fixture('large answer '.repeat(40_000));
    await removeConversationPageCaches(path.join(root, 'sessions'));
    vi.spyOn(FileSessionStorage.prototype, 'prepareConversationPageCache')
      .mockRejectedValue(new Error('forced cache preparation failure'));
    vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const page = await runtime.sessions.conversationPage({ sessionId, limit: 20 });
      const oversized = page?.entries.find((entry) => entry.oversized);
      if (page === null || oversized === undefined) throw new Error('oversized fallback entry missing');
      const current = await manager.storage.load(sessionId);
      if (current?.lineage === undefined) throw new Error('Session lineage missing');
      const appended = messageEntry('u4', current.lineage.activeEntryId, 'user', 'changed');
      await manager.storage.appendSessionDelta(sessionId, {
        ...current,
        lineage: {
          ...current.lineage,
          activeEntryId: appended.id,
          entries: [...current.lineage.entries, appended],
        },
        messages: [...current.messages, appended.message],
      });

      await expect(runtime.sessions.conversationEntryChunk({
        sessionId,
        revision: page.revision,
        entryIndex: oversized.index,
      })).rejects.toMatchObject({ code: 'resync_required' });
    } finally {
      await runtime.close();
    }
  });

  it('keeps raw transcript pages on their immutable snapshot after an append', async () => {
    const { manager, runtime, sessionId } = await fixture();
    try {
      const first = await runtime.sessions.transcriptPage({ sessionId, limit: 2 });
      if (first?.nextCursor === undefined) throw new Error('transcript page cursor missing');
      const current = await manager.storage.load(sessionId);
      if (current?.lineage === undefined) throw new Error('Session lineage missing');
      const appended = messageEntry('a4', current.lineage.activeEntryId, 'assistant', 'changed');
      await manager.storage.appendSessionDelta(sessionId, {
        ...current,
        lineage: {
          ...current.lineage,
          activeEntryId: appended.id,
          entries: [...current.lineage.entries, appended],
        },
        messages: [...current.messages, appended.message],
      });

      await expect(runtime.sessions.transcriptPage({
        sessionId,
        cursor: first.nextCursor,
        limit: 2,
      })).resolves.toMatchObject({ revision: first.revision });
    } finally {
      await runtime.close();
    }
  });

  it('forks against the exact history source revision and rejects a stale one', async () => {
    const { manager, runtime, sessionId } = await fixture();
    try {
      const history = await runtime.sessions.conversation(sessionId);
      if (history === null) throw new Error('conversation history missing');
      const first = history.entries[0];
      if (first?.boundaryId === undefined) throw new Error('boundary missing');

      const forked = await runtime.sessions.fork({
        sessionId,
        newSessionId: 'conversation-fork',
        historyBoundary: {
          entryId: first.boundaryId,
          sourceRevision: history.sourceRevision,
        },
      });
      expect(forked?.id).toBe('conversation-fork');
      await expect(runtime.sessions.fork({
        sessionId,
        newSessionId: 'stale-fork',
        historyBoundary: {
          entryId: first.boundaryId,
          sourceRevision: 'sha256:stale',
        },
      })).rejects.toMatchObject({ code: 'resync_required' });
      await expect(runtime.sessions.fork({
        sessionId,
        newSessionId: 'missing-boundary-fork',
        historyBoundary: {
          entryId: 'missing-entry',
          sourceRevision: history.sourceRevision,
        },
      })).resolves.toBeNull();
      await expect(manager.storage.load('missing-boundary-fork')).resolves.toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it('retrieves an oversized projected entry from the same immutable snapshot', async () => {
    const finalAnswer = 'large answer '.repeat(40_000);
    const { runtime, sessionId } = await fixture(finalAnswer);
    try {
      const direct = await runtime.sessions.conversation(sessionId);
      if (direct === null) throw new Error('conversation history missing');
      const page = await runtime.sessions.conversationPage({
        sessionId,
        limit: 20,
      });
      if (page === null) throw new Error('conversation page missing');
      const oversized = page.entries.find((entry) => entry.oversized);
      if (oversized === undefined) throw new Error('oversized entry missing');
      expect(oversized.entry).toBeUndefined();

      const chunks: Buffer[] = [];
      let cursor: string | undefined;
      do {
        const chunk = await runtime.sessions.conversationEntryChunk({
          sessionId,
          revision: page.revision,
          entryIndex: oversized.index,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        if (chunk === null) throw new Error('conversation chunk missing');
        chunks.push(Buffer.from(chunk.data, 'base64'));
        cursor = chunk.nextCursor;
      } while (cursor !== undefined);

      expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(
        direct.entries[oversized.index],
      );
    } finally {
      await runtime.close();
    }
  });

  it('keeps the conversation contract through Worker-hosted embedded transport', async () => {
    const { runtime, sessionId } = await fixture('third answer', 'worker');
    try {
      const direct = await runtime.sessions.conversation(sessionId);
      const page = await runtime.sessions.conversationPage({
        sessionId,
        limit: 20,
      });
      expect(page?.entries.map((entry) => entry.entry)).toEqual(direct?.entries);
      expect(page).toMatchObject({
        revision: direct?.revision,
        sourceRevision: direct?.sourceRevision,
        status: 'resolved',
      });
    } finally {
      await runtime.close();
    }
  });

  it('keeps ambiguous candidates and issues identical across direct and pages', async () => {
    const { runtime, sessionId } = await fixture('unused', 'inline', true);
    try {
      const direct = await runtime.sessions.conversation(sessionId);
      const page = await runtime.sessions.conversationPage({
        sessionId,
        limit: 20,
      });
      expect(direct).toMatchObject({
        status: 'ambiguous',
        issues: [expect.objectContaining({ code: 'legacy_overlap_ambiguous' })],
      });
      expect(page).toMatchObject({
        revision: direct?.revision,
        sourceRevision: direct?.sourceRevision,
        status: direct?.status,
        issues: direct?.issues,
      });
      expect(page?.entries.map((entry) => entry.entry)).toEqual(direct?.entries);
      expect(direct?.entries.map((entry) => entry.boundaryId)).toEqual([
        'u1',
        'a1',
        'legacy-u1-copy',
        'legacy-a1-copy',
        'u3',
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('does not let an embedded page caller mutate cached issue metadata', async () => {
    const { runtime, sessionId } = await fixture('unused', 'inline', true);
    try {
      const first = await runtime.sessions.conversationPage({
        sessionId,
        limit: 2,
      });
      if (first === null || first.nextCursor === undefined) {
        throw new Error('multi-page conversation missing');
      }
      const mutableIssues = first.issues;
      if (mutableIssues[0]) Array.prototype.push.call(mutableIssues[0].entryIds, 'caller-mutation');
      Array.prototype.push.call(mutableIssues, {
        code: 'caller_mutation',
        message: 'must not enter the snapshot',
        entryIds: [],
      });

      const second = await runtime.sessions.conversationPage({
        sessionId,
        cursor: first.nextCursor,
        limit: 2,
      });

      expect(second?.issues).toEqual([
        expect.objectContaining({
          code: 'legacy_overlap_ambiguous',
          entryIds: ['legacy-u1-copy', 'legacy-a1-copy'],
        }),
      ]);
    } finally {
      await runtime.close();
    }
  });
});
