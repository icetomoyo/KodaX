import type { KodaXMessage } from '@kodax-ai/llm';
import { isDeepStrictEqual } from 'node:util';
import { emitKodaXDiagnostic } from '../diagnostics.js';
import type {
  KodaXSessionData,
  KodaXSessionLineage,
  KodaXSessionStorage,
} from '../types.js';
import type { CompactionUpdate } from './compaction/types.js';
import { mergeArtifactLedger } from './compaction/file-tracker.js';
import {
  applySessionCompaction,
  createSessionLineage,
} from './kodax-session-lineage.js';

export interface PersistCompactedSessionHistoryInput {
  readonly storage: KodaXSessionStorage;
  readonly sessionId: string;
  readonly compactedMessages: readonly KodaXMessage[];
  readonly update: CompactionUpdate;
  /** Explicit metadata used only when a new Session compacts before its first routine snapshot. */
  readonly initialSessionData?: Omit<KodaXSessionData, 'messages' | 'lineage'>;
  readonly signal?: AbortSignal;
}

const TRANSIENT_STORAGE_ERRORS = new Set(['EIO', 'ENOSPC', 'EBUSY', 'EMFILE', 'ENFILE', 'ETIMEDOUT']);

/** Retry only transient persistence I/O; never rerun generation or tool dispatch. */
export async function retryContextPersistence<T>(
  perform: (attempt: number) => Promise<T>,
  input: { readonly signal?: AbortSignal; readonly sessionId?: string; readonly operation: string },
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    input.signal?.throwIfAborted();
    try { return await perform(attempt); } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (typeof code !== 'string' || !TRANSIENT_STORAGE_ERRORS.has(code)) throw error;
      input.signal?.throwIfAborted();
      const retryDelayMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
      emitKodaXDiagnostic({ source: 'agent:compaction', level: 'warn',
        message: 'History persistence is blocked; retrying the same storage operation.',
        detail: { sessionId: input.sessionId, operation: input.operation, code, attempt, retryDelayMs } });
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => input.signal?.removeEventListener('abort', abort);
        const timer = setTimeout(() => { cleanup(); resolve(); }, retryDelayMs);
        const abort = () => { clearTimeout(timer); cleanup(); reject(input.signal!.reason); };
        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) abort();
      });
    }
  }
}

/** Persist one exact root compaction transaction before its replacement is used. */
export async function persistCompactedSessionHistory(
  input: PersistCompactedSessionHistoryInput,
): Promise<KodaXSessionLineage> {
  const loaded = await retryContextPersistence(() => input.storage.load(input.sessionId), { ...input, operation: 'load' });
  if (!loaded && !input.initialSessionData) {
    throw new Error(`Cannot persist compaction for missing session: ${input.sessionId}`);
  }
  const preCompactionMessages = [...(input.update.preCompactionMessages ?? loaded?.messages ?? [])];
  const current: KodaXSessionData = loaded ?? {
    ...input.initialSessionData!,
    messages: preCompactionMessages,
    lineage: createSessionLineage(preCompactionMessages),
  };
  const exactBase = createSessionLineage(
    preCompactionMessages.length > 0 ? preCompactionMessages : current.messages,
    current.lineage,
  );
  const compactedMessages = [...input.compactedMessages];
  const lineage = input.update.anchor
    ? applySessionCompaction(
        exactBase,
        compactedMessages,
        input.update.anchor,
        input.update.postCompactAttachments ?? [],
      )
    : createSessionLineage(compactedMessages, exactBase);
  const artifactLedger = input.update.artifactLedger?.length
    ? mergeArtifactLedger(current.artifactLedger ?? [], input.update.artifactLedger)
    : current.artifactLedger;

  // Construct once: a save may have committed before its acknowledgement failed.
  // Read back on retry before writing: the acknowledged transaction may already
  // be present, with newer display/runtime metadata that must not be overwritten.
  const transaction: KodaXSessionData = {
    ...current,
    messages: compactedMessages,
    lineage,
    ...(artifactLedger !== undefined ? { artifactLedger } : {}),
  };
  await retryContextPersistence(async attempt => {
    let pending = transaction;
    if (attempt > 1) {
      const saved = await input.storage.load(input.sessionId);
      const savedIds = new Set(saved?.lineage?.entries.map(entry => entry.id));
      const ledgerSaved = artifactLedger?.every(entry =>
        saved?.artifactLedger?.some(candidate => isDeepStrictEqual(entry, candidate))) ?? true;
      // File-backed stores may move older entries into an archive during save.
      // The new active entry is the commit witness, not the archived prefix.
      const targetIsNew = !current.lineage?.entries.some(entry => entry.id === lineage.activeEntryId);
      const committed = saved?.lineage?.activeEntryId === lineage.activeEntryId
        || (targetIsNew && lineage.activeEntryId !== null && savedIds.has(lineage.activeEntryId));
      if (committed && ledgerSaved) return;
      if (saved) pending = { ...saved, messages: compactedMessages, lineage,
        ...(artifactLedger !== undefined
          ? { artifactLedger: mergeArtifactLedger(saved.artifactLedger ?? [], artifactLedger) } : {}) };
    }
    await input.storage.save(input.sessionId, pending);
  }, { ...input, operation: 'save' });
  return lineage;
}
