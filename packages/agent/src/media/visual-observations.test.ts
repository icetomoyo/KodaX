import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { expect, it } from 'vitest';
import { createFileVisualObservationOwner } from './visual-observations.js';

it('concurrent identical admissions share immutable bytes without treating a verified winning writer as a failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-same-bytes-'));
  const bytes = await new Jimp({ width: 2, height: 1, color: 0x00ff00ff }).getBuffer('image/png');
  try {
    const owners = Array.from({ length: 20 }, () => createFileVisualObservationOwner({ ownerId: 'same-owner', directory, list: async () => [] }));
    const records = await Promise.all(owners.map(owner => owner.pin(bytes, { sourceKey: 'parallel', originEntryId: 'committed-input', mediaType: 'image/png' })));
    expect(new Set(records.map(record => record.observationId)).size).toBe(20);
    expect(new Set(records.map(record => record.sha256)).size).toBe(1);
    expect(await readdir(directory)).toEqual([records[0]!.sha256]);
    expect(await owners[0]!.read(records[0]!)).toEqual(bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
