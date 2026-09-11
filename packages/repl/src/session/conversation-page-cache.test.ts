import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KodaXSessionEntry, KodaXSessionLineage } from '@kodax-ai/agent';

import {
  buildSessionConversationHistory,
  createConversationEntryChain,
  extendConversationEntryChain,
} from './conversation-history.js';
import {
  ConversationPageCacheStaleError,
  appendConversationPageCache,
  canAppendConversationPageCache,
  readConversationPageCache,
  readConversationPageCacheManifest,
  refreshConversationPageCache,
  writeConversationPageCache,
} from './conversation-page-cache.js';
import {
  createSessionSourceRevision,
  createSessionSourceRevisionState,
} from './source-revision.js';

const roots: string[] = [];

function messageEntry(
  id: string,
  parentId: string,
  role: 'user' | 'assistant',
  content: string,
): KodaXSessionEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-08-01T00:00:01.000Z',
    logicalId: id,
    message: { role, content },
  };
}

// Keep the managed-envelope shape in sync with managedContextEntry in
// conversation-history.test.ts.
function managedContextEntry(
  id: string,
  parentId: string,
  source: 'managed-run-context' | 'managed-runtime-context',
): KodaXSessionEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-08-01T00:00:01.000Z',
    logicalId: id,
    message: {
      role: 'user',
      content: 'replaceable managed context',
      _synthetic: true,
      _source: source,
    },
  };
}

async function fixture(content: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-conversation-cache-'));
  roots.push(root);
  const mainPath = path.join(root, 'session.jsonl');
  const lineage: KodaXSessionLineage = {
    version: 2,
    activeEntryId: 'entry-1',
    entries: [{
      type: 'message',
      id: 'entry-1',
      parentId: null,
      timestamp: '2026-08-01T00:00:00.000Z',
      logicalId: 'entry-1',
      message: { role: 'user', content },
    }],
  };
  const sourceRevisionState = createSessionSourceRevisionState([{
    kind: 'main',
    relativePath: 'session.jsonl',
    bytes: Buffer.from(content),
  }]);
  return {
    mainPath,
    lineage,
    sourceRevisionState,
    history: buildSessionConversationHistory(
      lineage,
      createSessionSourceRevision(sourceRevisionState),
    ),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

describe('Conversation page cache durability', () => {
  it('reuses immutable entry files when a full save keeps canonical history unchanged', async () => {
    const value = await fixture('unchanged-entry');
    await writeConversationPageCache(
      value.mainPath,
      'boundary:first',
      value.sourceRevisionState,
      value.history,
      value.lineage,
      { surface: 'repl' },
      1024,
    );
    const before = await readConversationPageCacheManifest(value.mainPath);
    const refreshedState = createSessionSourceRevisionState([{
      kind: 'main',
      relativePath: 'session.jsonl',
      bytes: Buffer.from('refreshed'),
    }]);
    const refreshedRevision = createSessionSourceRevision(refreshedState);
    const refreshedHistory = buildSessionConversationHistory(value.lineage, refreshedRevision);

    await expect(refreshConversationPageCache(
      value.mainPath,
      'boundary:refreshed',
      refreshedState,
      refreshedHistory,
      value.lineage,
      { surface: 'repl', profileId: 'default' },
    )).resolves.toBe(true);
    const after = await readConversationPageCacheManifest(value.mainPath);
    expect(after?.generation).toBe(before?.generation);
    await expect(readConversationPageCache(value.mainPath, 'boundary:refreshed', {
      limit: 1,
      maxPageBytes: 64 * 1024,
      maxInlineEntryBytes: 64 * 1024,
      reservedBytes: 0,
      authorize: (identity) => expect(identity).toEqual({
        surface: 'repl',
        profileId: 'default',
      }),
    })).resolves.toMatchObject({ sourceRevision: refreshedRevision });
  });

  it('rejects oversized manifests without reading them into memory', async () => {
    const value = await fixture('oversized-manifest');
    const manifestPath = value.mainPath.replace(/\.jsonl$/, '.conversation-cache.json');
    await fs.writeFile(manifestPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const readFile = vi.spyOn(fs, 'readFile');

    await expect(readConversationPageCacheManifest(value.mainPath)).resolves.toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([3, 4])('invalidates v%s caches after the ordinary-history projection changes', async (version) => {
    const value = await fixture('old-projection');
    await writeConversationPageCache(
      value.mainPath,
      'boundary:old-projection',
      value.sourceRevisionState,
      value.history,
      value.lineage,
      undefined,
      1024,
    );
    const manifestPath = value.mainPath.replace(/\.jsonl$/, '.conversation-cache.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.version = version;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    await expect(readConversationPageCacheManifest(value.mainPath)).resolves.toBeUndefined();
    await expect(readConversationPageCache(value.mainPath, 'boundary:old-projection', {
      limit: 1,
      maxPageBytes: 64 * 1024,
      maxInlineEntryBytes: 64 * 1024,
      reservedBytes: 0,
    })).resolves.toBeNull();
  });

  it('rejects an oversized descriptor before allocating its declared length', async () => {
    const value = await fixture('descriptor');
    await writeConversationPageCache(
      value.mainPath,
      'boundary:descriptor',
      value.sourceRevisionState,
      value.history,
      value.lineage,
      undefined,
      1024,
    );
    const manifestPath = value.mainPath.replace(/\.jsonl$/, '.conversation-cache.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      dataBytes: number;
      dataFile: string;
      indexFile: string;
    };
    const indexPath = path.join(path.dirname(value.mainPath), manifest.indexFile);
    const index = await fs.readFile(indexPath);
    const descriptorOffset = Number(index.readBigUInt64LE(12));
    const descriptorLength = 1024 * 1024 + 1;
    index.writeUInt32LE(descriptorLength, 20);
    await fs.writeFile(indexPath, index);
    const dataPath = path.join(path.dirname(value.mainPath), manifest.dataFile);
    const data = await fs.open(dataPath, 'r+');
    await data.truncate(descriptorOffset + descriptorLength);
    await data.close();
    const persistedManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    persistedManifest.dataBytes = descriptorOffset + descriptorLength;
    await fs.writeFile(manifestPath, JSON.stringify(persistedManifest));

    await expect(readConversationPageCache(value.mainPath, 'boundary:descriptor', {
      limit: 1,
      maxPageBytes: 64 * 1024,
      maxInlineEntryBytes: 64 * 1024,
      reservedBytes: 0,
    })).rejects.toBeInstanceOf(ConversationPageCacheStaleError);
  });

  it('keeps the committed generation readable when old-generation cleanup fails', async () => {
    const first = await fixture('first');
    await writeConversationPageCache(
      first.mainPath,
      'boundary:first',
      first.sourceRevisionState,
      first.history,
      first.lineage,
      { surface: 'repl' },
      1024,
    );
    const secondState = createSessionSourceRevisionState([{
      kind: 'main',
      relativePath: 'session.jsonl',
      bytes: Buffer.from('second'),
    }]);
    const second = {
      ...first,
      sourceRevisionState: secondState,
      history: buildSessionConversationHistory(
        first.lineage,
        createSessionSourceRevision(secondState),
      ),
    };
    vi.spyOn(fs, 'readdir').mockRejectedValueOnce(
      Object.assign(new Error('cleanup denied'), { code: 'EACCES' }),
    );
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    await expect(writeConversationPageCache(
      second.mainPath,
      'boundary:second',
      second.sourceRevisionState,
      second.history,
      second.lineage,
      { surface: 'repl' },
      1024,
    )).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('old Conversation page cache generation'),
      { code: 'KODAX_CONVERSATION_PAGE_CACHE_GC_FAILED' },
    );
    await expect(readConversationPageCache(second.mainPath, 'boundary:second', {
      limit: 1,
      maxPageBytes: 64 * 1024,
      maxInlineEntryBytes: 64 * 1024,
      reservedBytes: 0,
      authorize: (identity) => expect(identity).toEqual({ surface: 'repl' }),
    })).resolves.toMatchObject({
      sourceRevision: createSessionSourceRevision(second.sourceRevisionState),
      entries: [{ entry: { message: { content: 'first' } } }],
    });
  });

  it('maps a generation removed by a concurrent writer to an explicit stale read', async () => {
    const value = await fixture('missing-generation');
    await writeConversationPageCache(
      value.mainPath,
      'boundary:stable',
      value.sourceRevisionState,
      value.history,
      value.lineage,
      undefined,
      1024,
    );
    const manifest = await readConversationPageCacheManifest(value.mainPath);
    if (manifest === undefined) throw new Error('Conversation cache manifest missing');
    await fs.rm(path.join(path.dirname(value.mainPath), manifest.dataFile));

    await expect(readConversationPageCache(value.mainPath, 'boundary:stable', {
      limit: 1,
      maxPageBytes: 64 * 1024,
      maxInlineEntryBytes: 64 * 1024,
      reservedBytes: 0,
    })).rejects.toBeInstanceOf(ConversationPageCacheStaleError);
  });

  it('closes the data handle when opening the paired index fails', async () => {
    const value = await fixture('open-failure');
    const close = vi.fn(async () => undefined);
    vi.spyOn(fs, 'open')
      .mockResolvedValueOnce({ close } as unknown as Awaited<ReturnType<typeof fs.open>>)
      .mockRejectedValueOnce(Object.assign(new Error('index unavailable'), { code: 'EACCES' }));

    await expect(writeConversationPageCache(
      value.mainPath,
      'boundary:open-failure',
      value.sourceRevisionState,
      value.history,
      value.lineage,
      undefined,
      1024,
    )).rejects.toMatchObject({ code: 'EACCES' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rebuilds instead of appending onto an unresolved partial projection', async () => {
    const value = await fixture('partial-prefix');
    await writeConversationPageCache(
      value.mainPath,
      'boundary:partial',
      value.sourceRevisionState,
      value.history,
      value.lineage,
      undefined,
      1024,
    );
    const manifest = await readConversationPageCacheManifest(value.mainPath);
    if (manifest === undefined) throw new Error('Conversation cache manifest missing');
    const appendedLineage: KodaXSessionLineage = {
      ...value.lineage,
      activeEntryId: 'entry-2',
      entries: [
        ...value.lineage.entries,
        {
          type: 'message',
          id: 'entry-2',
          parentId: 'entry-1',
          timestamp: '2026-08-01T00:00:01.000Z',
          logicalId: 'entry-2',
          message: { role: 'assistant', content: 'strict append' },
        },
      ],
    };

    expect(canAppendConversationPageCache({
      ...manifest,
      status: 'partial',
      issues: [{
        code: 'lineage_path_incomplete',
        message: 'Older prefix is incomplete.',
        occurrenceCount: 1,
        entryCount: 1,
        entryIds: ['entry-1'],
      }],
    }, 'entry-1', appendedLineage.entries.slice(1), 'entry-2')).toBeUndefined();
  });

  it('appends through leading topology-transparent managed context', async () => {
    const value = await fixture('managed-context-prefix');
    await writeConversationPageCache(
      value.mainPath,
      'boundary:managed-context',
      value.sourceRevisionState,
      value.history,
      value.lineage,
      undefined,
      1024,
    );
    const manifest = await readConversationPageCacheManifest(value.mainPath);
    if (manifest === undefined) throw new Error('Conversation cache manifest missing');

    expect(canAppendConversationPageCache(manifest, 'entry-1', [
      managedContextEntry('entry-managed', 'entry-1', 'managed-runtime-context'),
      messageEntry('entry-query', 'entry-managed', 'user', 'real query'),
    ], 'entry-query')).toEqual([{
      boundaryId: 'entry-query',
      auditEntryIds: ['entry-query'],
      message: { role: 'user', content: 'real query' },
    }]);
  });

  it('appends real messages around a mid-batch managed context', async () => {
    const value = await fixture('managed-context-mid');
    await writeConversationPageCache(
      value.mainPath,
      'boundary:managed-context-mid',
      value.sourceRevisionState,
      value.history,
      value.lineage,
      undefined,
      1024,
    );
    const manifest = await readConversationPageCacheManifest(value.mainPath);
    if (manifest === undefined) throw new Error('Conversation cache manifest missing');

    expect(canAppendConversationPageCache(manifest, 'entry-1', [
      messageEntry('entry-tool', 'entry-1', 'user', 'tool result'),
      managedContextEntry('entry-managed', 'entry-tool', 'managed-runtime-context'),
      messageEntry('entry-answer', 'entry-managed', 'assistant', 'final answer'),
    ], 'entry-answer')).toEqual([
      {
        boundaryId: 'entry-tool',
        auditEntryIds: ['entry-tool'],
        message: { role: 'user', content: 'tool result' },
      },
      {
        boundaryId: 'entry-answer',
        auditEntryIds: ['entry-answer'],
        message: { role: 'assistant', content: 'final answer' },
      },
    ]);
  });

  it('advances the append chain across a managed-context-only batch', async () => {
    const value = await fixture('managed-context-only');
    await writeConversationPageCache(
      value.mainPath,
      'boundary:managed-context-only',
      value.sourceRevisionState,
      value.history,
      value.lineage,
      undefined,
      1024,
    );
    const manifest = await readConversationPageCacheManifest(value.mainPath);
    if (manifest === undefined) throw new Error('Conversation cache manifest missing');

    expect(canAppendConversationPageCache(manifest, 'entry-1', [
      managedContextEntry('entry-managed', 'entry-1', 'managed-run-context'),
    ], 'entry-managed')).toEqual([]);
  });

  it('checks append identity conflicts without traversing the persisted lineage prefix', async () => {
    const value = await fixture('bounded-identity-filter');
    await writeConversationPageCache(
      value.mainPath,
      'boundary:identity-filter',
      value.sourceRevisionState,
      value.history,
      value.lineage,
      undefined,
      1024,
    );
    const manifest = await readConversationPageCacheManifest(value.mainPath);
    if (manifest === undefined) throw new Error('Conversation cache manifest missing');
    const appended = [
      {
        type: 'message' as const,
        id: 'entry-2',
        parentId: 'entry-1',
        timestamp: '2026-08-01T00:00:01.000Z',
        logicalId: 'entry-2',
        message: { role: 'assistant' as const, content: 'bounded identity check' },
      },
    ];
    expect(canAppendConversationPageCache(
      manifest,
      'entry-1',
      appended,
      'entry-2',
    )).toMatchObject([{ boundaryId: 'entry-2' }]);
    expect(canAppendConversationPageCache(
      manifest,
      'entry-1',
      [{
        type: 'message',
        id: 'entry-1',
        parentId: 'entry-1',
        timestamp: '2026-08-01T00:00:01.000Z',
        logicalId: 'entry-1',
        message: { role: 'assistant', content: 'duplicate identity' },
      }],
      'entry-1',
    )).toBeUndefined();
  });

  it('keeps a leading managed passthrough append equivalent to a canonical rebuild', async () => {
    const value = await fixture('passthrough-leading-equivalence');
    await writeConversationPageCache(
      value.mainPath,
      'boundary:leading-equivalence',
      value.sourceRevisionState,
      value.history,
      value.lineage,
      undefined,
      1024,
    );
    const manifest = await readConversationPageCacheManifest(value.mainPath);
    if (manifest === undefined) throw new Error('Conversation cache manifest missing');
    const appended = [
      managedContextEntry('entry-managed', 'entry-1', 'managed-runtime-context'),
      messageEntry('entry-query', 'entry-managed', 'user', 'real query'),
    ];
    const projected = canAppendConversationPageCache(
      manifest,
      'entry-1',
      appended,
      'entry-query',
    );
    if (projected === undefined) throw new Error('Fast-path admission unexpectedly failed');
    const extendedLineage: KodaXSessionLineage = {
      ...value.lineage,
      activeEntryId: 'entry-query',
      entries: [...value.lineage.entries, ...appended],
    };
    const canonical = buildSessionConversationHistory(
      extendedLineage,
      createSessionSourceRevision(value.sourceRevisionState),
    );
    expect(canonical.status).toBe('resolved');
    expect(extendConversationEntryChain(manifest.entryChain, projected))
      .toBe(createConversationEntryChain(canonical.entries));

    await appendConversationPageCache(
      value.mainPath,
      manifest,
      'boundary:leading-appended',
      value.sourceRevisionState,
      projected,
      appended,
      'entry-query',
    );
    await expect(refreshConversationPageCache(
      value.mainPath,
      'boundary:leading-appended',
      value.sourceRevisionState,
      canonical,
      extendedLineage,
      undefined,
    )).resolves.toBe(true);
  });

  it('keeps a mid-batch managed passthrough append equivalent to a canonical rebuild', async () => {
    const value = await fixture('passthrough-mid-equivalence');
    await writeConversationPageCache(
      value.mainPath,
      'boundary:mid-equivalence',
      value.sourceRevisionState,
      value.history,
      value.lineage,
      undefined,
      1024,
    );
    const manifest = await readConversationPageCacheManifest(value.mainPath);
    if (manifest === undefined) throw new Error('Conversation cache manifest missing');
    const appended = [
      messageEntry('entry-tool', 'entry-1', 'user', 'tool result'),
      managedContextEntry('entry-managed', 'entry-tool', 'managed-run-context'),
      messageEntry('entry-answer', 'entry-managed', 'assistant', 'final answer'),
    ];
    const projected = canAppendConversationPageCache(
      manifest,
      'entry-1',
      appended,
      'entry-answer',
    );
    if (projected === undefined) throw new Error('Fast-path admission unexpectedly failed');
    expect(projected).toHaveLength(2);
    const canonical = buildSessionConversationHistory({
      ...value.lineage,
      activeEntryId: 'entry-answer',
      entries: [...value.lineage.entries, ...appended],
    }, createSessionSourceRevision(value.sourceRevisionState));
    expect(canonical.status).toBe('resolved');
    expect(extendConversationEntryChain(manifest.entryChain, projected))
      .toBe(createConversationEntryChain(canonical.entries));
  });

  it('persists a managed-only batch watermark and keeps the fast path warm', async () => {
    const value = await fixture('managed-only-watermark');
    await writeConversationPageCache(
      value.mainPath,
      'boundary:managed-only-watermark',
      value.sourceRevisionState,
      value.history,
      value.lineage,
      undefined,
      1024,
    );
    const manifest = await readConversationPageCacheManifest(value.mainPath);
    if (manifest === undefined) throw new Error('Conversation cache manifest missing');
    const batch = [managedContextEntry('entry-managed', 'entry-1', 'managed-run-context')];
    const projected = canAppendConversationPageCache(manifest, 'entry-1', batch, 'entry-managed');
    expect(projected).toEqual([]);
    await appendConversationPageCache(
      value.mainPath,
      manifest,
      'boundary:managed-only-appended',
      value.sourceRevisionState,
      projected,
      batch,
      'entry-managed',
    );
    const after = await readConversationPageCacheManifest(value.mainPath);
    if (after === undefined) throw new Error('Conversation cache manifest missing');
    expect(after.activeEntryId).toBe('entry-managed');
    expect(after.lineageEntryCount).toBe(manifest.lineageEntryCount + 1);
    expect(after.entryCount).toBe(manifest.entryCount);
    expect(after.entryChain).toBe(manifest.entryChain);
    expect(after.dataBytes).toBe(manifest.dataBytes);
    expect(after.indexBytes).toBe(manifest.indexBytes);

    const extendedLineage: KodaXSessionLineage = {
      ...value.lineage,
      activeEntryId: 'entry-managed',
      entries: [...value.lineage.entries, ...batch],
    };
    const canonical = buildSessionConversationHistory(
      extendedLineage,
      createSessionSourceRevision(value.sourceRevisionState),
    );
    expect(canonical.status).toBe('resolved');
    await expect(refreshConversationPageCache(
      value.mainPath,
      'boundary:managed-only-appended',
      value.sourceRevisionState,
      canonical,
      extendedLineage,
      undefined,
    )).resolves.toBe(true);

    expect(canAppendConversationPageCache(after, 'entry-managed', [
      messageEntry('entry-query', 'entry-managed', 'user', 'next real query'),
    ], 'entry-query')).toEqual([{
      boundaryId: 'entry-query',
      auditEntryIds: ['entry-query'],
      message: { role: 'user', content: 'next real query' },
    }]);
  });

  it('rejects a managed batch that does not extend the append chain', async () => {
    const value = await fixture('managed-chain-break');
    await writeConversationPageCache(
      value.mainPath,
      'boundary:managed-chain-break',
      value.sourceRevisionState,
      value.history,
      value.lineage,
      undefined,
      1024,
    );
    const manifest = await readConversationPageCacheManifest(value.mainPath);
    if (manifest === undefined) throw new Error('Conversation cache manifest missing');

    expect(canAppendConversationPageCache(manifest, 'entry-1', [
      managedContextEntry('entry-stray', 'entry-other', 'managed-runtime-context'),
      messageEntry('entry-query', 'entry-stray', 'user', 'real query'),
    ], 'entry-query')).toBeUndefined();
    expect(canAppendConversationPageCache(manifest, 'entry-1', [
      managedContextEntry('entry-managed', 'entry-1', 'managed-run-context'),
    ], 'entry-1')).toBeUndefined();
  });
});
