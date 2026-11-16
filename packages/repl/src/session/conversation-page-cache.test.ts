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
  readConversationPageCacheChunk,
  readConversationPageCacheManifest,
  readConversationPageCacheRevision,
  refreshConversationPageCache,
  removeConversationPageCache,
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
  it('locates canonical identities without reading unrelated large bodies and rejects old revisions', async () => {
    const value = await fixture('original');
    value.lineage.entries.push({
      type: 'message', id: 'output', logicalId: 'output', parentId: 'entry-1', timestamp: '2026-08-01T00:00:02.000Z',
      message: { role: 'assistant', outputId: 'target', content: 'x'.repeat(200_000) },
    });
    value.lineage.activeEntryId = 'output';
    const history = buildSessionConversationHistory(value.lineage, createSessionSourceRevision(value.sourceRevisionState));
    await writeConversationPageCache(value.mainPath, 'boundary:lookup', value.sourceRevisionState,
      history, value.lineage, undefined, 64 * 1024);
    const open = fs.open;
    const dataHandles: Awaited<ReturnType<typeof fs.open>>[] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.data')) { vi.spyOn(handle, 'read'); dataHandles.push(handle); }
      return handle;
    });
    const input = { sourceKeys: ['output:target'], limit: 80, maxPageBytes: 512 * 1024, maxInlineEntryBytes: 0, reservedBytes: 0 };
    const located = await readConversationPageCache(value.mainPath, 'boundary:lookup', input);
    expect(located?.entries).toMatchObject([{ index: 1, boundaryId: 'output', oversized: true }]);
    expect(located?.entries[0]?.entry).toBeUndefined();
    const readBytes = dataHandles.flatMap(handle => vi.mocked(handle.read).mock.calls)
      .reduce((total, call) => total + Number(call[2] ?? 0), 0);
    expect(readBytes).toBeLessThan(10_000);
    await expect(readConversationPageCache(value.mainPath, 'boundary:lookup', {
      ...input, expectedRevision: 'old-revision',
    })).rejects.toBeInstanceOf(ConversationPageCacheStaleError);
  });

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

  it('keeps an older page revision readable while its generation only grows', async () => {
    const value = await fixture('prefix-first');
    value.lineage.entries.push(
      messageEntry('entry-2', 'entry-1', 'assistant', 'prefix-second'),
      messageEntry('entry-3', 'entry-2', 'user', 'prefix-third'),
    );
    value.lineage.activeEntryId = 'entry-3';
    const sourceRevision = createSessionSourceRevision(value.sourceRevisionState);
    await writeConversationPageCache(value.mainPath, 'boundary:first', value.sourceRevisionState,
      buildSessionConversationHistory(value.lineage, sourceRevision), value.lineage, undefined, 1024);
    const input = { limit: 1, maxPageBytes: 64 * 1024, maxInlineEntryBytes: 64 * 1024, reservedBytes: 0 };
    const newest = await readConversationPageCache(value.mainPath, 'boundary:first', input);
    if (newest?.nextEnd === undefined) throw new Error('expected an older page cursor');
    const older = { ...input, expectedRevision: newest.revision, end: newest.nextEnd };

    const manifest = await readConversationPageCacheManifest(value.mainPath);
    if (manifest === undefined) throw new Error('Conversation cache manifest missing');
    const appended = [messageEntry('entry-4', 'entry-3', 'assistant', 'prefix-fourth')];
    const appendedState = createSessionSourceRevisionState([{
      kind: 'main', relativePath: 'session.jsonl', bytes: Buffer.from('prefix-appended'),
    }]);
    const projected = canAppendConversationPageCache(manifest, 'entry-3', appended, 'entry-4');
    if (projected === undefined) throw new Error('expected an appendable batch');
    await appendConversationPageCache(value.mainPath, manifest, 'boundary:appended', appendedState,
      projected, appended, 'entry-4');
    const extended = { ...value.lineage, activeEntryId: 'entry-4', entries: [...value.lineage.entries, ...appended] };
    const refreshedState = createSessionSourceRevisionState([{
      kind: 'main', relativePath: 'session.jsonl', bytes: Buffer.from('prefix-ui-checkpoint'),
    }]);
    await expect(refreshConversationPageCache(value.mainPath, 'boundary:refreshed', refreshedState,
      buildSessionConversationHistory(extended, createSessionSourceRevision(refreshedState)), extended, undefined))
      .resolves.toBe(true);
    // An append in flight grows the files before it replaces the manifest.
    const current = await readConversationPageCacheManifest(value.mainPath);
    if (current === undefined) throw new Error('Conversation cache manifest missing');
    await fs.appendFile(path.join(path.dirname(value.mainPath), current.dataFile), 'in-flight');

    // The writer's boundary is not needed: the revision witnesses the immutable prefix.
    const page = await readConversationPageCache(value.mainPath, undefined, older);
    expect(page).toMatchObject({ revision: newest.revision, sourceRevision, nextEnd: 1 });
    expect(page?.entries.map((item) => item.entry?.message.content)).toEqual(['prefix-second']);
    await expect(readConversationPageCacheChunk(value.mainPath, undefined, {
      revision: newest.revision, entryIndex: 2, offset: 0,
    })).resolves.toMatchObject({ revision: newest.revision, entryIndex: 2 });
    // The older revision ends at its own last entry, not at entries appended after it.
    const olderTail = await readConversationPageCache(value.mainPath, undefined, {
      ...input, expectedRevision: newest.revision, end: 99,
    });
    expect(olderTail?.entries.map((item) => item.entry?.message.content)).toEqual(['prefix-third']);
    expect(olderTail?.newerStart).toBeUndefined();
    await expect(readConversationPageCacheChunk(value.mainPath, undefined, {
      revision: newest.revision, entryIndex: 3, offset: 0,
    })).resolves.toBeUndefined();

    // A Run saves by rewriting the session; a rebuild that keeps the prefix still serves the page.
    await writeConversationPageCache(value.mainPath, 'boundary:rewritten', refreshedState,
      buildSessionConversationHistory(extended, createSessionSourceRevision(refreshedState)), extended, undefined, 1024);
    await expect(readConversationPageCache(value.mainPath, undefined, older))
      .resolves.toMatchObject({ revision: newest.revision, sourceRevision });

    const edited = {
      ...extended,
      entries: extended.entries.map((entry) => entry.id === 'entry-2'
        ? messageEntry('entry-2', 'entry-1', 'assistant', 'edited-second')
        : entry),
    };
    await writeConversationPageCache(value.mainPath, 'boundary:edited', refreshedState,
      buildSessionConversationHistory(edited, createSessionSourceRevision(refreshedState)), edited, undefined, 1024);
    await expect(readConversationPageCache(value.mainPath, undefined, older))
      .rejects.toBeInstanceOf(ConversationPageCacheStaleError);
  });

  it('retries an older page whose generation a concurrent prefix rebuild retired mid-read', async () => {
    const value = await fixture('race-first');
    value.lineage.entries.push(messageEntry('entry-2', 'entry-1', 'assistant', 'race-second'));
    value.lineage.activeEntryId = 'entry-2';
    const sourceRevision = createSessionSourceRevision(value.sourceRevisionState);
    await writeConversationPageCache(value.mainPath, 'boundary:first', value.sourceRevisionState,
      buildSessionConversationHistory(value.lineage, sourceRevision), value.lineage, undefined, 1024);
    const input = { limit: 1, maxPageBytes: 64 * 1024, maxInlineEntryBytes: 64 * 1024, reservedBytes: 0 };
    const newest = await readConversationPageCache(value.mainPath, 'boundary:first', input);
    if (newest?.nextEnd === undefined) throw new Error('expected an older page cursor');
    const extended = { ...value.lineage, activeEntryId: 'entry-3',
      entries: [...value.lineage.entries, messageEntry('entry-3', 'entry-2', 'user', 'race-third')] };
    const state = createSessionSourceRevisionState([{
      kind: 'main', relativePath: 'session.jsonl', bytes: Buffer.from('race-rebuilt'),
    }]);
    // A Run save rebuilds the cache after the reader took its manifest, retiring that generation.
    let rebuilds = 0;
    const rebuildOnce = async (): Promise<void> => {
      if (rebuilds++ > 0) return;
      await writeConversationPageCache(value.mainPath, 'boundary:rebuilt', state,
        buildSessionConversationHistory(extended, createSessionSourceRevision(state)), extended, undefined, 1024);
    };

    await expect(readConversationPageCache(value.mainPath, undefined, {
      ...input, expectedRevision: newest.revision, end: newest.nextEnd, authorize: rebuildOnce,
    })).resolves.toMatchObject({ revision: newest.revision, sourceRevision,
      entries: [{ entry: { message: { content: 'race-first' } } }] });
    rebuilds = 0;
    await expect(readConversationPageCacheChunk(value.mainPath, undefined, {
      revision: newest.revision, entryIndex: 1, offset: 0, authorize: rebuildOnce,
    })).resolves.toMatchObject({ revision: newest.revision, entryIndex: 1 });
  });

  it('commits the manifest while a Windows reader briefly holds the old one open', async () => {
    const value = await fixture('held-manifest');
    await writeConversationPageCache(value.mainPath, 'boundary:first', value.sourceRevisionState,
      value.history, value.lineage, undefined, 1024);
    const state = createSessionSourceRevisionState([{
      kind: 'main', relativePath: 'session.jsonl', bytes: Buffer.from('held-checkpoint'),
    }]);
    // Windows refuses to replace a file another handle has open: rename reports EPERM.
    const held = Object.assign(new Error('operation not permitted, rename'), { code: 'EPERM' });
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(held).mockRejectedValueOnce(held);

    await expect(refreshConversationPageCache(value.mainPath, 'boundary:held', state,
      buildSessionConversationHistory(value.lineage, createSessionSourceRevision(state)), value.lineage, undefined))
      .resolves.toBe(true);
    await expect(readConversationPageCacheManifest(value.mainPath))
      .resolves.toMatchObject({ boundaryRevision: 'boundary:held' });
  });

  it('keeps an older page readable across a long Run of checkpoint-only saves', async () => {
    const value = await fixture('long-run-first');
    value.lineage.entries.push(messageEntry('entry-2', 'entry-1', 'assistant', 'long-run-second'));
    value.lineage.activeEntryId = 'entry-2';
    const sourceRevision = createSessionSourceRevision(value.sourceRevisionState);
    await writeConversationPageCache(value.mainPath, 'boundary:first', value.sourceRevisionState,
      buildSessionConversationHistory(value.lineage, sourceRevision), value.lineage, undefined, 1024);
    const input = { limit: 1, maxPageBytes: 64 * 1024, maxInlineEntryBytes: 64 * 1024, reservedBytes: 0 };
    const newest = await readConversationPageCache(value.mainPath, 'boundary:first', input);
    if (newest?.nextEnd === undefined) throw new Error('expected an older page cursor');

    // A streaming Run checkpoints its view twice a second; each save is a new revision.
    for (let checkpoint = 0; checkpoint < 300; checkpoint += 1) {
      const state = createSessionSourceRevisionState([{
        kind: 'main', relativePath: 'session.jsonl', bytes: Buffer.from(`checkpoint-${checkpoint}`),
      }]);
      await expect(refreshConversationPageCache(value.mainPath, `boundary:${checkpoint}`, state,
        buildSessionConversationHistory(value.lineage, createSessionSourceRevision(state)), value.lineage, undefined))
        .resolves.toBe(true);
    }

    await expect(readConversationPageCache(value.mainPath, undefined, {
      ...input, expectedRevision: newest.revision, end: newest.nextEnd,
    })).resolves.toMatchObject({ revision: newest.revision, sourceRevision, hasMore: false });
    await expect(readConversationPageCacheChunk(value.mainPath, undefined, {
      revision: newest.revision, entryIndex: 0, offset: 0,
    })).resolves.toMatchObject({ revision: newest.revision, entryIndex: 0 });
    const current = await readConversationPageCacheManifest(value.mainPath);
    await expect(readConversationPageCacheRevision(value.mainPath, { sourceRevision }))
      .resolves.toEqual({ revision: newest.revision, sourceRevision, entryCount: 2, currentRevision: current?.revision });
    await expect(readConversationPageCacheRevision(value.mainPath, { revision: 'sha256:unknown' }))
      .resolves.toBeUndefined();
  });

  it('rewrites a full revision log with its newest half and ignores a torn trailing record', async () => {
    const value = await fixture('full-log');
    await writeConversationPageCache(value.mainPath, 'boundary:first', value.sourceRevisionState,
      value.history, value.lineage, undefined, 1024);
    const first = await readConversationPageCacheManifest(value.mainPath);
    const checkpoint = async (label: string): Promise<void> => {
      const state = createSessionSourceRevisionState([{
        kind: 'main', relativePath: 'session.jsonl', bytes: Buffer.from(label),
      }]);
      await expect(refreshConversationPageCache(value.mainPath, `boundary:${label}`, state,
        buildSessionConversationHistory(value.lineage, createSessionSourceRevision(state)), value.lineage, undefined))
        .resolves.toBe(true);
    };
    await checkpoint('second');
    const second = await readConversationPageCacheManifest(value.mainPath);
    if (first === undefined || second === undefined) throw new Error('Conversation cache manifest missing');
    const logPath = path.join(path.dirname(value.mainPath), second.revisionLog);
    const record = await fs.readFile(logPath);
    expect(record).toHaveLength(72);
    // Fill the log to its cap behind the real record, then tear an append.
    await fs.writeFile(logPath, Buffer.concat([Buffer.alloc(72 * 16_383), record, Buffer.from('torn')]));
    await expect(readConversationPageCacheRevision(value.mainPath, { revision: first.revision }))
      .resolves.toMatchObject({ sourceRevision: first.sourceRevision, entryCount: 1 });

    await checkpoint('third');
    const third = await readConversationPageCacheManifest(value.mainPath);
    if (third === undefined) throw new Error('Conversation cache manifest missing');
    expect(third.revisionLog).not.toBe(second.revisionLog);
    await expect(fs.stat(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(path.join(path.dirname(value.mainPath), third.revisionLog))).size).toBe(72 * 8_193);
    for (const revision of [first.revision, second.revision, third.revision]) {
      await expect(readConversationPageCacheRevision(value.mainPath, { revision }))
        .resolves.toMatchObject({ revision, currentRevision: third.revision });
    }
    await removeConversationPageCache(value.mainPath);
    expect(await fs.readdir(path.dirname(value.mainPath))).toEqual([]);
  });

  it('rejects oversized manifests without reading them into memory', async () => {
    const value = await fixture('oversized-manifest');
    const manifestPath = value.mainPath.replace(/\.jsonl$/, '.conversation-cache.json');
    await fs.writeFile(manifestPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const readFile = vi.spyOn(fs, 'readFile');

    await expect(readConversationPageCacheManifest(value.mainPath)).resolves.toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([3, 4, 5, 6, 7, 8, 9])('invalidates v%s caches after the ordinary-history projection changes', async (version) => {
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
