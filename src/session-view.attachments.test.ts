import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ClientViewItem } from '@kodax-ai/coding/client-contract';
import { SessionViewOwner } from './session-view.js';

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
