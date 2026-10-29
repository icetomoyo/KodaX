import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionLineage, evictOldIslandMessageContent, persistCompactedSessionHistory, setKodaXDiagnosticSink, type KodaXMessage } from '@kodax-ai/agent';
import { createFileVisualObservationOwner, sessionVisualMediaDirectory, visualObservationRecord } from '@kodax-ai/agent/media';
import { createSessionVisualObservationOwner } from '@kodax-ai/coding';
import { FileSessionStorage } from './storage.js';

afterEach(() => vi.restoreAllMocks());

it.each(process.platform === 'win32' ? [false, true] : [false])('forks the selected visual prefix with independent media and stable identities; changedRootCase=%s', async changedRootCase => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-fork-'));
  const sessionsDir = path.join(root, 'sessions');
  let storage = new FileSessionStorage({ sessionsDir, configHome: root });
  const directory = (id: string) => sessionVisualMediaDirectory(sessionsDir, id);
  const owner = (id: string) => createSessionVisualObservationOwner(storage, id, directory(id));
  try {
    const writer = createFileVisualObservationOwner({ ownerId: 'parent', directory: directory('parent'), list: async () => [] });
    const green = await new Jimp({ width: 2, height: 2, color: 0x00ff00ff }).getBuffer('image/png');
    const red = await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/png');
    const first = await writer.pin(green, { sourceKey: 'user', originEntryId: 'input:first', mediaType: 'image/png' });
    const messages: KodaXMessage[] = [
      { role: 'user', inputId: 'first', content: [{ type: 'text', text: 'First image.' }, { type: 'image', path: writer.imagePath(first) }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'read', input: { path: 'mutable.png' } }] },
    ];
    let lineage = createSessionLineage(messages);
    const readEntry = lineage.activeEntryId!;
    const second = await writer.pin(red, { sourceKey: 'read', originEntryId: readEntry, mediaType: 'image/png' });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: [{ type: 'image', path: writer.imagePath(second) }] }] });
    const derivedBytes = await new Jimp({ width: 1, height: 1, color: 0x0000ffff }).getBuffer('image/png');
    const derived = await writer.writeDerived(derivedBytes);
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'inspect', name: 'visual_inspect', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'inspect', content: [{ type: 'image', path: derived }] }] });
    lineage = createSessionLineage(messages, lineage);
    const forkAt = lineage.activeEntryId!;
    messages.push({ role: 'user', inputId: 'future', content: 'Future parent input.' });
    lineage = createSessionLineage(messages, lineage);
    const future = await writer.pin(red, { sourceKey: 'user', originEntryId: 'input:future', mediaType: 'image/png' });
    await storage.save('parent', { title: 'Visual parent', gitRoot: root, messages, lineage,
      extensionRecords: [first, second, future].map(visualObservationRecord) });
    if (changedRootCase) storage = new FileSessionStorage({ sessionsDir: sessionsDir.toUpperCase(), configHome: root });
    const child = await storage.fork('parent', forkAt, { sessionId: 'child' });
    expect(child).not.toBeNull();
    expect((await owner('child').list()).map(item => item.observationId)).toEqual([first.observationId, second.observationId]);
    const inherited = (await owner('child').list())[1]!;
    expect(inherited.ownerId).toBe('child');
    expect(child!.data.lineage!.entries.some(entry => entry.id === readEntry)).toBe(false);
    expect(child!.data.extensionRecords?.some(record => record.id === future.observationId)).toBe(false);
    await storage.setActiveEntry('child', child!.data.lineage!.entries[0]!.id);
    expect((await owner('child').list()).map(item => item.observationId)).toEqual([first.observationId]);
    await storage.setActiveEntry('child', child!.data.lineage!.activeEntryId!);
    const early = await storage.fork('parent', lineage.entries[0]!.id, { sessionId: 'early' });
    expect(early).not.toBeNull();
    expect((await owner('early').list()).map(item => item.observationId)).toEqual([first.observationId]);
    await expect(owner('parent').read(inherited)).rejects.toThrow(/denied/);
    const childWriter = createFileVisualObservationOwner({ ownerId: 'child', directory: directory('child'), list: async () => [] });
    const later = await childWriter.pin(red, { sourceKey: 'user', originEntryId: 'input:child-only', mediaType: 'image/png' });
    const childData = (await storage.load('child'))!;
    const childMessages: KodaXMessage[] = [...childData.messages, { role: 'user', inputId: 'child-only', content: 'Child-only observation.' }];
    await storage.save('child', { ...childData, messages: childMessages, lineage: createSessionLineage(childMessages, childData.lineage),
      extensionRecords: [...childData.extensionRecords!, visualObservationRecord(later)] });
    expect((await owner('parent').list()).map(item => item.observationId)).toEqual([first.observationId, second.observationId, future.observationId]);
    expect((await owner('child').list()).map(item => item.observationId)).toEqual([first.observationId, second.observationId, later.observationId]);
    await storage.archive('parent');
    expect((await writer.read(first)).equals(green)).toBe(true);
    await storage.delete('parent');
    expect((await owner('child').read(inherited)).equals(red)).toBe(true);
    const contentImages = child!.data.messages.flatMap(message => Array.isArray(message.content) ? message.content.flatMap(block =>
      block.type === 'image' ? [block] : block.type === 'tool_result' && Array.isArray(block.content) ? block.content.filter(item => item.type === 'image') : []) : []);
    expect(contentImages).toHaveLength(3);
    expect(contentImages.every(image => path.relative(directory('child'), path.dirname(image.path)) === '')).toBe(true);
    expect((await readFile(contentImages[0]!.path)).equals(green)).toBe(true);
    expect((await readFile(contentImages[2]!.path)).equals(derivedBytes)).toBe(true);
    await storage.delete('child');
    await expect(readdir(directory('child'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await owner('early').read((await owner('early').list())[0]!)).equals(green)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects crossing forks into two existing owners without mutually waiting on their write locks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-fork-crossing-'));
  const sessionsDir = path.join(root, 'sessions');
  const storage = new FileSessionStorage({ sessionsDir, configHome: root });
  try {
    const bytes = await new Jimp({ width: 1, height: 1, color: 0x00ff00ff }).getBuffer('image/png');
    for (const id of ['left', 'right']) {
      const owner = createFileVisualObservationOwner({ ownerId: id, directory: sessionVisualMediaDirectory(sessionsDir, id), list: async () => [] });
      const observation = await owner.pin(bytes, { sourceKey: 'user', originEntryId: 'input:first', mediaType: 'image/png' });
      await storage.save(id, { title: id, gitRoot: root, messages: [{ role: 'user', inputId: 'first', content: id }], extensionRecords: [visualObservationRecord(observation)] });
    }
    const results = await Promise.allSettled([storage.fork('left', undefined, { sessionId: 'right' }), storage.fork('right', undefined, { sessionId: 'left' })]);
    expect(results).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ message: 'Visual fork target Session already exists.' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ message: 'Visual fork target Session already exists.' }) })]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);

it('records failed physical media deletion and retries only that owner while a fork stays readable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-delete-retry-'));
  const sessionsDir = path.join(root, 'sessions');
  const storage = new FileSessionStorage({ sessionsDir, configHome: root });
  const directory = (id: string) => sessionVisualMediaDirectory(sessionsDir, id);
  const warnings: string[] = [];
  const restore = setKodaXDiagnosticSink(diagnostic => { if (diagnostic.level === 'warn') warnings.push(diagnostic.message); });
  try {
    const writer = createFileVisualObservationOwner({ ownerId: 'parent', directory: directory('parent'), list: async () => [] });
    const bytes = await new Jimp({ width: 2, height: 2, color: 0x00ff00ff }).getBuffer('image/png');
    const observation = await writer.pin(bytes, { sourceKey: 'user', originEntryId: 'input:first', mediaType: 'image/png' });
    await storage.save('parent', { title: 'Delete retry', gitRoot: root, messages: [{ role: 'user', inputId: 'first', content: 'Retained original.' }], extensionRecords: [visualObservationRecord(observation)] });
    await storage.fork('parent', undefined, { sessionId: 'child' });
    const remove = fs.rm.bind(fs);
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target).startsWith(`${directory('parent')}.`) && String(target).endsWith('.deleting.tmp')) throw new Error('Retained file is locked.');
      return remove(target, options);
    });
    await storage.delete('parent');
    expect(await storage.load('parent')).toBeNull();
    expect(warnings.some(message => message.includes('tombstone'))).toBe(true);
    const rootMedia = path.dirname(directory('parent'));
    expect((await readdir(rootMedia)).some(name => name.startsWith(`${path.basename(directory('parent'))}.`))).toBe(true);
    vi.restoreAllMocks();
    await storage.delete('parent');
    expect((await readdir(rootMedia)).some(name => name.startsWith(`${path.basename(directory('parent'))}.`))).toBe(false);
    const child = createSessionVisualObservationOwner(storage, 'child', directory('child'));
    expect((await child.read((await child.list())[0]!)).equals(bytes)).toBe(true);
  } finally { restore(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
});

it('rejects a foreign Actor owner before deleting retained media tombstones', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-owner-delete-'));
  const sessionsDir = path.join(root, 'sessions');
  const storage = new FileSessionStorage({ sessionsDir, configHome: root });
  const directory = sessionVisualMediaDirectory(sessionsDir, 'owned');
  const tombstone = `${directory}.1.2.3.deleting.tmp`;
  try {
    await storage.save('owned', { title: 'Existing owner', gitRoot: root, messages: [{ role: 'user', content: 'Preserve ownership.' }] });
    await fs.mkdir(tombstone, { recursive: true }); await fs.writeFile(path.join(tombstone, 'retained'), 'Retained cleanup bytes.');
    await expect(storage.deleteOwned('owned', 'foreign-owner')).rejects.toMatchObject({ code: 'actor_owner_conflict' });
    expect(await readFile(path.join(tombstone, 'retained'), 'utf8')).toBe('Retained cleanup bytes.');
    expect(await storage.load('owned')).not.toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['missing', 'hash', 'copy', 'canonical', 'after-commit', 'cleanup', 'canonical-cleanup', 'context-path', 'context-hash', 'context-missing'] as const)(
  'preserves the fork commit boundary and retryable media cleanup when %s fails', async failure => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-fork-failure-'));
  const sessionsDir = path.join(root, 'sessions');
  const storage = new FileSessionStorage({ sessionsDir, configHome: root });
  const directory = (id: string) => sessionVisualMediaDirectory(sessionsDir, id);
  try {
    const writer = createFileVisualObservationOwner({ ownerId: 'parent', directory: directory('parent'), list: async () => [] });
    const bytes = await new Jimp({ width: 2, height: 2, color: 0x00ff00ff }).getBuffer('image/png');
    const observation = await writer.pin(bytes, { sourceKey: 'user', originEntryId: 'input:first', mediaType: 'image/png' });
    await storage.save('parent', { title: 'Failure boundaries', gitRoot: root, messages: [{ role: 'user', inputId: 'first', content: 'Keep the admitted original.' }],
      extensionRecords: [visualObservationRecord(observation)] });
    if (failure.startsWith('context-')) {
      let retained = await writer.writeDerived(await new Jimp({ width: 1, height: 1, color: 0x0000ffff }).getBuffer('image/png'));
      if (failure === 'context-path') retained = path.join(directory('parent'), 'invalid-retained-filename');
      if (failure === 'context-hash') await fs.writeFile(retained, 'Corrupted derived image.');
      if (failure === 'context-missing') await rm(retained);
      const saved = (await storage.load('parent'))!;
      await storage.save('parent', { ...saved, messages: [...saved.messages, { role: 'user', content: [{ type: 'image', path: retained }] }], lineage: undefined });
    }
    if (failure === 'missing') await rm(writer.imagePath(observation));
    if (failure === 'hash') await fs.writeFile(writer.imagePath(observation), 'Corrupted retained original.');
    const rename = fs.rename.bind(fs); const remove = fs.rm.bind(fs);
    const create = fs.mkdir.bind(fs);
    if (failure === 'copy' || failure === 'cleanup') vi.spyOn(fs, 'mkdir').mockImplementation(async (target, options) => {
      const result = await create(target, options);
      if (String(target) === directory('child')) await create(path.join(directory('child'), observation.sha256));
      return result;
    });
    if (['canonical', 'after-commit', 'canonical-cleanup'].includes(failure)) vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      const canonicalFailure = path.basename(String(to)) === 'child.jsonl';
      if (canonicalFailure && failure === 'after-commit') await rename(from, to);
      if (canonicalFailure) throw new Error(`Injected ${failure} failure.`);
      return rename(from, to);
    });
    if (failure === 'cleanup' || failure === 'canonical-cleanup') vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === directory('child')) throw new Error('Injected media cleanup failure.');
      return remove(target, options);
    });
    const attempt = storage.fork('parent', undefined, { sessionId: 'child' });
    if (failure === 'canonical-cleanup') await expect(attempt).rejects.toMatchObject({ name: 'AggregateError', errors: [expect.objectContaining({ message: 'Injected canonical-cleanup failure.' }), expect.objectContaining({ message: 'Injected media cleanup failure.' })] });
    else await expect(attempt).rejects.toThrow();
    vi.restoreAllMocks();
    if (failure === 'after-commit') {
      expect(await storage.load('child')).not.toBeNull();
      const owner = createSessionVisualObservationOwner(storage, 'child', directory('child'));
      expect((await owner.read((await owner.list())[0]!)).equals(bytes)).toBe(true);
      await expect(storage.fork('parent', undefined, { sessionId: 'child' })).rejects.toThrow(/already exists/);
    } else {
      expect(await storage.load('child')).toBeNull();
      if (failure === 'cleanup' || failure === 'canonical-cleanup') await storage.delete('child');
      await expect(readdir(directory('child'))).rejects.toMatchObject({ code: 'ENOENT' });
      if (failure.startsWith('context-')) {
        expect((await writer.read(observation)).equals(bytes)).toBe(true);
        return;
      }
      await fs.writeFile(writer.imagePath(observation), bytes);
      expect(await storage.fork('parent', undefined, { sessionId: 'child' })).not.toBeNull();
      expect((await writer.read(observation)).equals(bytes)).toBe(true);
    }
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
});

it.each([false, true])('retains exact visual ancestry through two compactions, sidecar reload and fork; historyBoundary=%s', async historyBoundary => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-compact-fork-'));
  const sessionsDir = path.join(root, 'sessions');
  let storage = new FileSessionStorage({ sessionsDir, configHome: root });
  const directory = (id: string) => sessionVisualMediaDirectory(sessionsDir, id);
  try {
    const writer = createFileVisualObservationOwner({ ownerId: 'parent', directory: directory('parent'), list: async () => [] });
    const bytes = await new Jimp({ width: 2, height: 2, color: 0x0000ffff }).getBuffer('image/png');
    const observation = await writer.pin(bytes, { sourceKey: 'user', originEntryId: 'input:first', mediaType: 'image/png' });
    const messages: KodaXMessage[] = [{ role: 'user', inputId: 'first', content: [{ type: 'text', text: 'Keep the blue original.' }, { type: 'image', path: writer.imagePath(observation) }] },
      { role: 'assistant', content: 'Observed.' }, { role: 'user', inputId: 'tail', content: 'Continue the same task.' }];
    await storage.save('parent', { title: 'Two compactions', gitRoot: root, messages, extensionRecords: [visualObservationRecord(observation)] });
    for (let round = 0; round < 2; round++) {
      const before = (await storage.load('parent'))!;
      const summary = `Compaction ${round}: retain ${observation.observationId}.`;
      await persistCompactedSessionHistory({ storage, sessionId: 'parent', compactedMessages: [{ role: 'system', content: `[对话历史摘要]\n\n${summary}` }, before.messages.at(-1)!],
        update: { preCompactionMessages: before.messages, anchor: { summary, tokensBefore: 100, tokensAfter: 20, entriesRemoved: before.messages.length - 1, reason: 'manual' } } });
      const compacted = (await storage.load('parent'))!;
      await storage.save('parent', { ...compacted, lineage: evictOldIslandMessageContent(compacted.lineage!) });
    }
    storage = new FileSessionStorage({ sessionsDir, configHome: root });
    const parent = createSessionVisualObservationOwner(storage, 'parent', directory('parent'));
    expect((await parent.list()).map(item => item.observationId)).toEqual([observation.observationId]);
    const snapshot = (await storage.readFullSnapshot('parent'))!;
    expect(snapshot.lineage!.entries.some(entry => entry.type === 'message' && entry.message.inputId === 'first')).toBe(true);
    const child = historyBoundary
      ? await storage.fork('parent', snapshot.lineage!.activeEntryId!, { sessionId: 'child', historyBoundary: { sourceRevision: snapshot.sourceRevision } })
      : await storage.fork('parent', undefined, { sessionId: 'child' });
    expect(child).not.toBeNull();
    const owner = createSessionVisualObservationOwner(storage, 'child', directory('child'));
    expect((await owner.list()).map(item => item.observationId)).toEqual([observation.observationId]);
    await storage.delete('parent');
    expect((await owner.read((await owner.list())[0]!)).equals(bytes)).toBe(true);
    const beforeFork = (await owner.list())[0]!;
    const again = await storage.fork('child', undefined, { sessionId: 'grandchild' });
    expect(again).not.toBeNull();
    await storage.delete('child');
    const grandchild = createSessionVisualObservationOwner(storage, 'grandchild', directory('grandchild'));
    expect((await grandchild.list()).map(item => item.observationId)).toEqual([beforeFork.observationId]);
    expect((await grandchild.read((await grandchild.list())[0]!)).equals(bytes)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
