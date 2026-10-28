import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ImageValidation, KodaXToolResultContentItem } from '@kodax-ai/llm';
import { prepareValidatedImageBlock } from '@kodax-ai/llm';
import type { KodaXExtensionSessionRecord } from '../types.js';
import { emitKodaXDiagnostic } from '../diagnostics.js';

/** Canonical receipts are authoritative; this module owns only immutable media files. */
export type VisualObservationSource = {
  imageOrdinal: number;
  inputId?: string;
  runId?: string;
  toolCallId?: string;
  executionId?: string;
  callOrdinal?: number;
  cellId?: string;
  leafReceiptId?: number;
};

export interface VisualObservation {
  observationId: string;
  ownerId: string;
  sourceKey: string;
  observedAt: string;
  originEntryId: string;
  sha256: string;
  mediaType: string;
  width?: number;
  height?: number;
  source?: VisualObservationSource;
}

export interface VisualObservationOwner {
  readonly ownerId: string;
  list(): Promise<readonly VisualObservation[]>;
  historyScope(): Promise<string>;
  pin(bytes: Buffer, input: Pick<VisualObservation, 'sourceKey' | 'originEntryId' | 'mediaType' | 'source'>): Promise<VisualObservation>;
  read(observation: VisualObservation, maxBytes?: number): Promise<Buffer>;
  imagePath(observation: VisualObservation): string;
  writeDerived(bytes: Buffer): Promise<string>;
}

export function sessionVisualMediaDirectory(sessionsDir: string, ownerId: string): string {
  return path.join(sessionsDir, '.media', createHash('sha256').update(ownerId).digest('hex'));
}

export function visualObservationRecord(observation: VisualObservation): KodaXExtensionSessionRecord {
  return { id: observation.observationId, extensionId: 'kodax.visual', type: 'observation',
    ts: Date.parse(observation.observedAt), data: { ...observation } };
}

export function readVisualObservationRecord(record: KodaXExtensionSessionRecord): VisualObservation | undefined {
  if (record.extensionId !== 'kodax.visual' || record.type !== 'observation' || !record.data
    || typeof record.data !== 'object' || Array.isArray(record.data)) return undefined;
  const value = record.data;
  if (typeof value.observationId !== 'string' || !/^obs_[a-f0-9-]{36}$/.test(value.observationId)
    || typeof value.ownerId !== 'string' || typeof value.sourceKey !== 'string'
    || typeof value.observedAt !== 'string' || typeof value.originEntryId !== 'string'
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.mediaType !== 'string') return undefined;
  return { observationId: value.observationId, ownerId: value.ownerId, sourceKey: value.sourceKey,
    observedAt: value.observedAt, originEntryId: value.originEntryId, sha256: value.sha256, mediaType: value.mediaType,
    ...(typeof value.width === 'number' ? { width: value.width } : {}),
    ...(typeof value.height === 'number' ? { height: value.height } : {}),
    ...(value.source && typeof value.source === 'object' && !Array.isArray(value.source)
      && typeof value.source.imageOrdinal === 'number' ? { source: value.source as VisualObservationSource } : {}) };
}

export function createFileVisualObservationOwner(options: {
  readonly ownerId: string;
  readonly directory: string;
  /** Only committed receipts visible on the owner's active lineage. No image I/O. */
  readonly list: () => Promise<readonly VisualObservation[]>;
  readonly historyScope?: () => Promise<string>;
}): VisualObservationOwner {
  const imagePath = (observation: Pick<VisualObservation, 'ownerId' | 'sha256'>): string => {
    if (observation.ownerId !== options.ownerId || !/^[a-f0-9]{64}$/.test(observation.sha256)) {
      throw new Error('Visual observation access denied.');
    }
    return path.join(options.directory, observation.sha256);
  };
  const persist = async (bytes: Buffer): Promise<string> => {
    const file = imagePath({ ownerId: options.ownerId, sha256: createHash('sha256').update(bytes).digest('hex') });
    await mkdir(options.directory, { recursive: true });
    try {
      if (!bytes.equals(await readFile(file))) throw new Error('Visual observation hash mismatch.');
      return file;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, file); }
    catch (error) {
      try { await unlink(temporary); }
      catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'Visual snapshot write and cleanup failed.'); }
      throw error;
    }
    return file;
  };
  return {
    ownerId: options.ownerId,
    historyScope: options.historyScope ?? (async () => options.ownerId),
    list: async () => (await options.list()).filter(value => value.ownerId === options.ownerId),
    imagePath,
    writeDerived: persist,
    async pin(bytes, input) {
      const observation: VisualObservation = { ...input, ownerId: options.ownerId,
        observationId: `obs_${randomUUID()}`, observedAt: new Date().toISOString(),
        sha256: createHash('sha256').update(bytes).digest('hex'), ...await imageDimensions(bytes) };
      await persist(bytes);
      return observation;
    },
    async read(observation, maxBytes = 10 * 1024 * 1024) {
      let bytes: Buffer;
      try {
        const file = await open(imagePath(observation), 'r');
        try {
          const size = (await file.stat()).size;
          if (size > maxBytes) throw new Error('Visual input exceeds the byte limit; request a smaller view.');
          bytes = Buffer.alloc(size);
          let offset = 0;
          while (offset < size) {
            const read = await file.read(bytes, offset, size - offset, offset);
            if (read.bytesRead === 0) throw new Error('Visual observation hash mismatch.');
            offset += read.bytesRead;
          }
          if ((await file.stat()).size !== size) throw new Error('Visual observation hash mismatch.');
        } finally { await file.close(); }
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Visual observation missing.');
        throw error;
      }
      if (createHash('sha256').update(bytes).digest('hex') !== observation.sha256) {
        throw new Error('Visual observation hash mismatch.');
      }
      return bytes;
    },
  };
}

async function imageDimensions(bytes: Buffer): Promise<{ width?: number; height?: number }> {
  try {
    const { imageSize } = await import('image-size');
    const dimensions = imageSize(bytes);
    return { width: dimensions.width, height: dimensions.height };
  } catch (error) {
    emitKodaXDiagnostic({ source: 'agent:visual-media', level: 'warn', message: 'Visual dimensions unavailable; original bytes retained.',
      detail: { reason: error instanceof Error ? error.message : String(error) } });
    return {};
  }
}

export function visualObservationLabel(observation: VisualObservation): string {
  return `${observation.observationId}; source=${observation.sourceKey}; observedAt=${observation.observedAt}; historical; `
    + `${observation.width ?? 'unknown'}x${observation.height ?? 'unknown'}; sha256=${observation.sha256}`;
}

export function visualObservationImage(owner: VisualObservationOwner, observation: VisualObservation,
  bytes: Buffer, validation: ImageValidation): readonly KodaXToolResultContentItem[] {
  const image = { type: 'image' as const, path: owner.imagePath(observation), mediaType: observation.mediaType };
  prepareValidatedImageBlock(image, bytes, validation);
  return [{ type: 'text', text: visualObservationLabel(observation) }, image];
}
