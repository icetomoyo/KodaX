import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ClientViewItem } from '@kodax-ai/coding/client-contract';
import { SessionViewOwner, restoreSessionViewItems } from './session-view.js';
import type { KodaXSessionData } from '@kodax-ai/agent';
import { createSessionLineage, searchSessionHistory } from '@kodax-ai/agent';
import { prepareRuntimeVisualInput, materializeRuntimeVisualArtifacts } from './runtime-visual-input.js';
import { projectHistoryEntry } from './client-history.js';

it('retains canonical user image references for distinct accepted inputs in the current view', async () => {
  const data: KodaXSessionData = { title: 'Images', gitRoot: '', messages: [
    { role: 'user', inputId: 'first', content: [{ type: 'text', text: 'inspect' }, { type: 'image', path: '/first.png', mediaType: 'image/png' }] },
    { role: 'user', inputId: 'second', content: [{ type: 'text', text: 'inspect' }, { type: 'image', path: '/second.png', mediaType: 'image/png' }] },
  ] };
  const owner = new SessionViewOwner(async () => ({ session: { id: 'images', title: data.title }, settings: {},
    items: restoreSessionViewItems('images', data, data.messages), queue: [], interactions: [], runs: [] }), async () => {});
  let view: import('@kodax-ai/coding/client-contract').ClientSessionView | undefined;
  const observation = await owner.observe('images', value => { view = value; });
  try {
    expect(view!.items.map(item => ({ id: item.id, attachments: item.attachments }))).toEqual([
      { id: 'images:input:first', attachments: [{ kind: 'image', path: '/first.png', mediaType: 'image/png' }] },
      { id: 'images:input:second', attachments: [{ kind: 'image', path: '/second.png', mediaType: 'image/png' }] },
    ]);
  } finally { observation.close(); await owner.close(); }
});

it.each([
  { queued: false, count: 1, imageOnly: false }, { queued: true, count: 1, imageOnly: false },
  { queued: false, count: 2, imageOnly: false }, { queued: true, count: 2, imageOnly: false },
  { queued: false, count: 1, imageOnly: true }, { queued: true, count: 1, imageOnly: true },
])('keeps model labels out of user text (queued=$queued images=$count imageOnly=$imageOnly)', async ({ queued, count, imageOnly }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-user-text-'));
  const source = path.resolve('tests/fixtures/images/valid-png.png');
  const text = imageOnly ? '' : '  Original user text.\nImage 1: obs_literal; source=user; keep this.\n';
  try {
    const prepared = await prepareRuntimeVisualInput({ sessionId: 's', inputId: 'input', sessionsDir: root,
      session: { title: 'Images', gitRoot: '', messages: [] },
      content: [{ type: 'text', text }, ...Array.from({ length: count }, () => ({ type: 'image' as const, path: source }))] });
    let content = prepared.content;
    if (queued) {
      const stable = await materializeRuntimeVisualArtifacts({ sessionId: 's', inputId: 'input', sessionsDir: root,
        session: { title: 'Images', gitRoot: '', messages: [], extensionRecords: prepared.records },
        artifacts: Array.from({ length: count }, () => ({ kind: 'image' as const, path: source })) });
      content = [{ type: 'text', text: `${text}\n${stable.labels.join('\n')}` },
        ...stable.artifacts.map(artifact => ({ type: 'image' as const, path: artifact.path, mediaType: artifact.mediaType }))];
    }
    const data: KodaXSessionData = { title: 'Images', gitRoot: '', messages: [{ role: 'user', inputId: 'input', content }],
      extensionRecords: prepared.records,
      uiHistory: [{ type: 'user', inputId: 'input', text: 'Old display with model labels.' }] };
    const [view] = restoreSessionViewItems('s', data, data.messages);
    const [history] = projectHistoryEntry('s', 'sha256:12345678', 0, data.messages);
    expect(view?.text).toBe(text);
    expect(history?.text).toBe(text);
    expect(view?.attachments).toHaveLength(count);
    const metadata = prepared.records[0]!.data;
    expect(view?.attachments?.[0]).toMatchObject(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { observationId: metadata.observationId, sha256: metadata.sha256, width: metadata.width, height: metadata.height } : {});
    expect(history?.attachments).toEqual(view?.attachments);
    const lineage = createSessionLineage(data.messages);
    if (!imageOnly) {
      const search = searchSessionHistory(lineage, { query: 'Original user text', scope: 'all' });
      expect(search.hits[0]?.snippet).not.toContain('observedAt=');
    }
    expect(searchSessionHistory(lineage, { query: 'observedAt', scope: 'all' }).hits).toEqual([]);
    expect(JSON.stringify(data.messages)).toContain('observedAt=');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reads only the image attached to a known Host item with exact bytes and hash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-image-'));
  const bytes = await readFile('tests/fixtures/images/valid-png.png');
  const imagePath = path.join(root, 'evidence.png');
  await writeFile(imagePath, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const item: ClientViewItem = { id: 'tool-image', type: 'tool', text: 'Rendered evidence',
    attachments: [{ kind: 'image', path: imagePath, mediaType: 'image/png' }] };
  const owner = new SessionViewOwner(async () => ({ session: { id: 's', title: 'Images' }, settings: {},
    items: [item], queue: [], interactions: [], runs: [] }), async () => {});
  try {
    const result = await owner.readItem('s', item.id, { part: 'attachment', attachmentIndex: 0, expectedImageSha256: sha256 });
    expect(result?.image).toMatchObject({ mediaType: 'image/png', sha256, offset: 0, totalLength: bytes.length,
      dataBase64: bytes.toString('base64') });
    expect(await owner.readItem('s', 'not-a-host-item', { part: 'attachment', attachmentIndex: 0 })).toBeNull();
    await expect(owner.readItem('s', item.id, { part: 'attachment', attachmentIndex: 1 })).rejects.toThrow(/attachment/i);
    await expect(owner.readItem('s', item.id, { part: 'attachment', attachmentIndex: 0, expectedImageSha256: 'a'.repeat(64) })).rejects.toThrow(/changed|hash/i);
    expect(await owner.readItem('s', item.id)).toMatchObject({ text: 'Rendered evidence' });
  } finally { await owner.close(); await rm(root, { recursive: true, force: true }); }
});

it('streams a JPEG in bounded chunks and rejects bytes changed between reads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-image-chunks-'));
  const bytes = Buffer.concat([await readFile('tests/fixtures/images/valid.jpg'), Buffer.alloc(512 * 1024)]);
  const imagePath = path.join(root, 'image');
  await writeFile(imagePath, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const owner = new SessionViewOwner(async () => ({ session: { id: 's', title: 'Images' }, settings: {},
    items: [{ id: 'image', type: 'user', text: '', attachments: [{ kind: 'image', path: imagePath }] }],
    queue: [], interactions: [], runs: [] }), async () => {});
  try {
    const first = (await owner.readItem('s', 'image', { part: 'attachment', attachmentIndex: 0, expectedImageSha256: sha256 }))!.image!;
    expect(first).toMatchObject({ mediaType: 'image/jpeg', sha256, offset: 0, nextOffset: 524288, totalLength: bytes.length });
    const last = (await owner.readItem('s', 'image', { part: 'attachment', attachmentIndex: 0,
      attachmentOffset: first.nextOffset, expectedImageSha256: sha256 }))!.image!;
    expect(last.nextOffset).toBeUndefined();
    expect(Buffer.concat([Buffer.from(first.dataBase64, 'base64'), Buffer.from(last.dataBase64, 'base64')])).toEqual(bytes);
    await writeFile(imagePath, await readFile('tests/fixtures/images/valid-png.png'));
    await expect(owner.readItem('s', 'image', { part: 'attachment', attachmentIndex: 0,
      attachmentOffset: first.nextOffset, expectedImageSha256: sha256 })).rejects.toThrow(/hash changed/i);
  } finally { await owner.close(); await rm(root, { recursive: true, force: true }); }
});

it('preserves label-shaped user text beside an image that is not bound to that Host observation', () => {
  const text = `obs_00000000-0000-0000-0000-000000000000; source=user; observedAt=2026-11-12; historical; 1x1; sha256=${'a'.repeat(64)}`;
  const data: KodaXSessionData = { title: 'Literal text', gitRoot: '', messages: [{ role: 'user', inputId: 'literal',
    content: [{ type: 'text', text }, { type: 'image', path: '/original.png' }] }] };
  expect(restoreSessionViewItems('s', data)[0]).toMatchObject({ text,
    attachments: [{ kind: 'image', path: '/original.png' }] });
});

it('rejects non-image bytes and invalid attachment offsets without returning file content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-image-invalid-'));
  const imagePath = path.join(root, 'not-image.png');
  await writeFile(imagePath, 'private text');
  const owner = new SessionViewOwner(async () => ({ session: { id: 's', title: 'Images' }, settings: {},
    items: [{ id: 'image', type: 'tool', text: '', attachments: [{ kind: 'image', path: imagePath }] }],
    queue: [], interactions: [], runs: [] }), async () => {});
  try {
    await expect(owner.readItem('s', 'image', { part: 'attachment', attachmentIndex: 0 })).rejects.toThrow(/PNG|image/i);
    await expect(owner.readItem('s', 'image', { part: 'attachment', attachmentIndex: -1 })).rejects.toThrow(/index|attachment/i);
    await expect(owner.readItem('s', 'image', { part: 'attachment', attachmentIndex: 0, attachmentOffset: -1 })).rejects.toThrow(/offset/i);
  } finally { await owner.close(); await rm(root, { recursive: true, force: true }); }
});

it.each([
  ['valid-png.png', 'image/png'], ['valid.jpg', 'image/jpeg'],
  ['valid.webp', 'image/webp'], ['valid.gif', 'image/gif'],
])('reads %s through the Host with its actual media type and byte offsets', async (fixture, mediaType) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-image-format-'));
  const bytes = await readFile(path.join('tests/fixtures/images', fixture));
  const imagePath = path.join(root, 'image');
  await writeFile(imagePath, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const item: ClientViewItem = { id: 'user-image', type: 'user', text: 'Inspect this.',
    attachments: [{ kind: 'image', path: imagePath, mediaType: 'image/png' }] };
  const owner = new SessionViewOwner(async () => ({ session: { id: 's', title: 'Images' }, settings: {},
    items: [item], queue: [], interactions: [], runs: [] }), async () => {});
  try {
    const image = (await owner.readItem('s', item.id, { part: 'attachment', attachmentIndex: 0, expectedImageSha256: sha256 }))!.image!;
    expect(image).toMatchObject({ mediaType, sha256, offset: 0, totalLength: bytes.length, dataBase64: bytes.toString('base64') });
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBeGreaterThan(0);
    const tail = (await owner.readItem('s', item.id, { part: 'attachment', attachmentIndex: 0,
      attachmentOffset: bytes.length - 3, expectedImageSha256: sha256 }))!.image!;
    expect(tail).toMatchObject({ mediaType, sha256, offset: bytes.length - 3, dataBase64: bytes.subarray(-3).toString('base64') });
    expect(tail.nextOffset).toBeUndefined();
    await expect(owner.readItem('s', item.id, { part: 'attachment', attachmentIndex: 0,
      expectedImageSha256: 'a'.repeat(64) })).rejects.toThrow(/hash changed/i);
    await expect(owner.readItem('s', item.id, { part: 'attachment', attachmentIndex: 0,
      attachmentOffset: bytes.length + 1 })).rejects.toThrow(/offset/i);
  } finally { await owner.close(); await rm(root, { recursive: true, force: true }); }
});
