/**
 * KodaX session storage - filesystem implementation.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import chalk from 'chalk';
import type {
  KodaXExtensionSessionRecord,
  KodaXMessage,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionData,
  KodaXSessionEntry,
  KodaXSessionLineage,
  KodaXSessionMeta,
  KodaXSessionRuntimeInfo,
  KodaXSessionScope,
  KodaXSessionStorage,
} from '@kodax/coding';
import {
  appendSessionLineageLabel,
  archiveOldIslands,
  cleanupIncompleteToolCalls,
  countActiveLineageMessages,
  createSessionLineage,
  findPreviousUserEntryId,
  forkSessionLineage,
  generateSessionId,
  getSessionMessagesFromLineage,
  rewindSessionLineage,
  setSessionLineageActiveEntry,
} from '@kodax/coding';
import type { SessionData, SessionErrorMetadata } from '../ui/utils/session-storage.js';
import { getGitRoot, KODAX_SESSIONS_DIR } from '../common/utils.js';
import { inspectWorkspaceRuntime, isSameCanonicalRepo, resolveSessionRuntimeInfo } from './workspace-runtime.js';
import {
  isKodaXExtensionSessionRecord,
  isKodaXExtensionSessionState,
  isKodaXJsonValue,
  isKodaXMessage,
  isKodaXSessionUiHistory,
  isRecord,
  isSessionErrorMetadata,
} from './json-guards.js';

interface PersistedExtensionRecordLine extends KodaXExtensionSessionRecord {
  _type: 'extension_record';
}

interface PersistedLineageEntryLine {
  _type: 'lineage_entry';
  entry: KodaXSessionEntry;
}

interface PersistedArtifactLedgerLine {
  _type: 'artifact_ledger_entry';
  entry: KodaXSessionArtifactLedgerEntry;
}

interface PersistedMetaUpdateLine {
  _type: 'meta_update';
  title?: string;
  activeEntryId?: string | null;
  activeMessageCount?: number;
  uiHistory?: KodaXSessionMeta['uiHistory'];
  scope?: string;
}

function isPersistedMetaUpdateLine(value: unknown): value is PersistedMetaUpdateLine {
  if (!isRecord(value) || value._type !== 'meta_update') {
    return false;
  }
  return (value.title === undefined || typeof value.title === 'string')
    && (value.activeEntryId === undefined || typeof value.activeEntryId === 'string' || value.activeEntryId === null)
    && (value.activeMessageCount === undefined || typeof value.activeMessageCount === 'number')
    && (value.uiHistory === undefined || isKodaXSessionUiHistory(value.uiHistory))
    && (value.scope === undefined || typeof value.scope === 'string');
}

interface PersistedSessionSnapshot {
  meta?: KodaXSessionMeta;
  legacyMessages: KodaXMessage[];
  lineageEntries: KodaXSessionEntry[];
  artifactLedger: KodaXSessionArtifactLedgerEntry[];
  extensionRecords: KodaXExtensionSessionRecord[];
  malformedCount: number;
}

interface ResolvedSessionSnapshot {
  data: SessionData;
  createdAt?: string;
}

function warnMalformedSessionData(filePath: string, count: number): void {
  if (count === 0 || process.env.NODE_ENV === 'test') {
    return;
  }

  process.stderr.write(
    `[KodaX] Skipped ${count} malformed session record(s) from ${path.basename(filePath)}.\n`,
  );
}

function writeStorageNotice(message: string): void {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  process.stderr.write(`${message}\n`);
}

function toExtensionRecordLine(
  record: KodaXExtensionSessionRecord,
): PersistedExtensionRecordLine {
  return {
    _type: 'extension_record',
    ...record,
  };
}

function toLineageEntryLine(entry: KodaXSessionEntry): PersistedLineageEntryLine {
  return {
    _type: 'lineage_entry',
    entry,
  };
}

function toArtifactLedgerLine(entry: KodaXSessionArtifactLedgerEntry): PersistedArtifactLedgerLine {
  return {
    _type: 'artifact_ledger_entry',
    entry,
  };
}

function isPersistedExtensionRecordLine(
  value: unknown,
): value is PersistedExtensionRecordLine {
  return isRecord(value)
    && value._type === 'extension_record'
    && isKodaXExtensionSessionRecord(value);
}

function hasEntryBase(value: unknown): value is { id: string; parentId: string | null; timestamp: string; type: string } {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.parentId === null || typeof value.parentId === 'string')
    && typeof value.timestamp === 'string'
    && typeof value.type === 'string';
}

function isKodaXSessionEntry(value: unknown): value is KodaXSessionEntry {
  if (!hasEntryBase(value)) {
    return false;
  }

  const entry = value as Record<string, unknown>;

  switch (entry.type) {
    case 'message':
      return isKodaXMessage(entry.message);
    case 'compaction':
      return typeof entry.summary === 'string'
        && (entry.firstKeptEntryId === undefined || typeof entry.firstKeptEntryId === 'string')
        && (entry.tokensBefore === undefined || typeof entry.tokensBefore === 'number');
    case 'branch_summary':
      return typeof entry.summary === 'string'
        && (entry.fromId === undefined || typeof entry.fromId === 'string')
        && (entry.details === undefined || isKodaXJsonValue(entry.details));
    case 'label':
      return typeof entry.targetId === 'string'
        && (entry.label === undefined || typeof entry.label === 'string');
    case 'archive_marker':
      return typeof entry.archiveBatchId === 'string'
        && typeof entry.archivedEntryCount === 'number'
        && typeof entry.summary === 'string';
    default:
      return false;
  }
}

function isPersistedLineageEntryLine(
  value: unknown,
): value is PersistedLineageEntryLine {
  return isRecord(value)
    && value._type === 'lineage_entry'
    && isKodaXSessionEntry(value.entry);
}

function isKodaXSessionArtifactLedgerEntry(
  value: unknown,
): value is KodaXSessionArtifactLedgerEntry {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.kind === 'string'
    && typeof value.target === 'string'
    && typeof value.timestamp === 'string'
    && (value.sourceTool === undefined || typeof value.sourceTool === 'string')
    && (value.action === undefined || typeof value.action === 'string')
    && (value.displayTarget === undefined || typeof value.displayTarget === 'string')
    && (value.summary === undefined || typeof value.summary === 'string')
    && (value.sessionEntryId === undefined || typeof value.sessionEntryId === 'string')
    && (value.metadata === undefined || isKodaXJsonValue(value.metadata));
}

function isPersistedArtifactLedgerLine(
  value: unknown,
): value is PersistedArtifactLedgerLine {
  return isRecord(value)
    && value._type === 'artifact_ledger_entry'
    && isKodaXSessionArtifactLedgerEntry(value.entry);
}

function isKodaXSessionRuntimeInfo(value: unknown): value is KodaXSessionRuntimeInfo {
  return isRecord(value)
    && (value.canonicalRepoRoot === undefined || typeof value.canonicalRepoRoot === 'string')
    && (value.workspaceRoot === undefined || typeof value.workspaceRoot === 'string')
    && (value.executionCwd === undefined || typeof value.executionCwd === 'string')
    && (value.branch === undefined || typeof value.branch === 'string')
    && (
      value.workspaceKind === undefined
      || value.workspaceKind === 'detected'
      || value.workspaceKind === 'managed'
    );
}

function getLastNavigableEntryId(entries: KodaXSessionEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && entry.type !== 'label') {
      return entry.id;
    }
  }
  return null;
}

function buildLineage(
  snapshot: PersistedSessionSnapshot,
): KodaXSessionLineage | undefined {
  if (snapshot.lineageEntries.length > 0) {
    return {
      version: 2,
      activeEntryId: snapshot.meta?.activeEntryId ?? getLastNavigableEntryId(snapshot.lineageEntries),
      entries: snapshot.lineageEntries,
    };
  }

  if (snapshot.legacyMessages.length === 0) {
    return undefined;
  }

  return createSessionLineage(snapshot.legacyMessages);
}

function buildSessionData(snapshot: PersistedSessionSnapshot): ResolvedSessionSnapshot {
  const lineage = buildLineage(snapshot);
  return {
    createdAt: snapshot.meta?.createdAt,
      data: {
        messages: lineage
          ? getSessionMessagesFromLineage(lineage)
          : [...snapshot.legacyMessages],
        title: snapshot.meta?.title ?? '',
        gitRoot: snapshot.meta?.gitRoot ?? '',
        runtimeInfo: isKodaXSessionRuntimeInfo(snapshot.meta?.runtimeInfo)
          ? { ...snapshot.meta.runtimeInfo }
          : undefined,
        scope: snapshot.meta?.scope ?? 'user',
        uiHistory: isKodaXSessionUiHistory(snapshot.meta?.uiHistory)
          ? snapshot.meta.uiHistory.map((item) => ({ ...item }))
          : undefined,
        errorMetadata: isSessionErrorMetadata(snapshot.meta?.errorMetadata)
          ? { ...snapshot.meta!.errorMetadata }
          : undefined,
      extensionState: isKodaXExtensionSessionState(snapshot.meta?.extensionState)
        ? snapshot.meta?.extensionState
        : undefined,
      extensionRecords: snapshot.extensionRecords.map((record) => ({ ...record })),
      lineage,
      artifactLedger: snapshot.artifactLedger.map((entry) => ({
        ...entry,
        metadata: entry.metadata ? structuredClone(entry.metadata) : undefined,
      })),
    },
  };
}

function createSessionMeta(
  id: string,
  data: SessionData,
  lineage: KodaXSessionLineage | undefined,
  createdAt?: string,
): KodaXSessionMeta {
  return {
    _type: 'meta',
    title: data.title,
    id,
    gitRoot: data.gitRoot,
    runtimeInfo: data.runtimeInfo ? { ...data.runtimeInfo } : undefined,
    createdAt: createdAt ?? new Date().toISOString(),
    scope: data.scope ?? 'user',
    uiHistory: data.uiHistory,
    errorMetadata: data.errorMetadata,
    extensionState: data.extensionState,
    extensionRecordCount: data.extensionRecords?.length ?? 0,
    artifactLedgerCount: data.artifactLedger?.length ?? 0,
    lineageVersion: lineage?.version,
    activeEntryId: lineage?.activeEntryId,
    lineageEntryCount: lineage?.entries.length ?? 0,
    activeMessageCount: lineage ? countActiveLineageMessages(lineage) : data.messages.length,
  };
}

async function readPersistedSessionFile(filePath: string): Promise<PersistedSessionSnapshot | null> {
  if (!fsSync.existsSync(filePath)) {
    return null;
  }

  const rawContent = await fs.readFile(filePath, 'utf-8');
  const trimmedContent = rawContent.trim();
  if (!trimmedContent) {
    return null;
  }

  const snapshot: PersistedSessionSnapshot = {
    legacyMessages: [],
    lineageEntries: [],
    artifactLedger: [],
    extensionRecords: [],
    malformedCount: 0,
  };

  const lines = trimmedContent.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const parsed = JSON.parse(lines[index]!);
      if (index === 0 && isRecord(parsed) && parsed._type === 'meta') {
        snapshot.meta = parsed as unknown as KodaXSessionMeta;
        continue;
      }

      // meta_update: white-list merge into existing meta (append-only hot path support)
      if (isPersistedMetaUpdateLine(parsed)) {
        if (snapshot.meta) {
          if (parsed.title !== undefined) snapshot.meta.title = parsed.title;
          if (parsed.activeEntryId !== undefined) snapshot.meta.activeEntryId = parsed.activeEntryId;
          if (parsed.activeMessageCount !== undefined) snapshot.meta.activeMessageCount = parsed.activeMessageCount;
          if (parsed.uiHistory !== undefined) snapshot.meta.uiHistory = parsed.uiHistory;
          if (parsed.scope !== undefined) snapshot.meta.scope = parsed.scope as KodaXSessionScope;
        }
        continue;
      }

      if (isPersistedLineageEntryLine(parsed)) {
        snapshot.lineageEntries.push(parsed.entry);
        continue;
      }

      if (isPersistedArtifactLedgerLine(parsed)) {
        snapshot.artifactLedger.push(parsed.entry);
        continue;
      }

      if (isPersistedExtensionRecordLine(parsed)) {
        snapshot.extensionRecords.push({
          id: parsed.id,
          extensionId: parsed.extensionId,
          type: parsed.type,
          ts: parsed.ts,
          data: parsed.data,
          dedupeKey: parsed.dedupeKey,
        });
        continue;
      }

      if (isKodaXMessage(parsed)) {
        snapshot.legacyMessages.push(parsed);
        continue;
      }

      snapshot.malformedCount += 1;
    } catch {
      snapshot.malformedCount += 1;
    }
  }

  return snapshot;
}

export class FileSessionStorage implements KodaXSessionStorage {
  // ── Session-level write serialization ──
  // All writes (append / cold save / maintenance) for the same session are
  // serialized through a per-session promise chain.  State reads, delta
  // computation, and writes all happen inside the queued callback.
  private writeQueues = new Map<string, Promise<void>>();

  private serializedWrite(id: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeQueues.get(id) ?? Promise.resolve();
    const next = prev.then(fn, () => fn());
    this.writeQueues.set(id, next);
    return next;
  }

  // ── Append watermarks ──
  // Tracks how many entries have been written to disk per session.
  // When the count matches the in-memory lineage, only new entries are appended.
  // On process restart the cache is empty → first save falls back to full write.
  // load() initializes the watermark so subsequent appends don't need fallback.
  private appendState = new Map<string, {
    lineageCount: number;
    artifactCount: number;
    extensionCount: number;
    metaUpdateCount: number;
  }>();

  /** Update watermarks. Only overwrites fields the caller actually provided. */
  private syncAppendState(id: string, data: SessionData, metaUpdateCount?: number): void {
    const prev = this.appendState.get(id);
    this.appendState.set(id, {
      lineageCount: data.lineage?.entries.length ?? prev?.lineageCount ?? 0,
      artifactCount: data.artifactLedger?.length ?? prev?.artifactCount ?? 0,
      extensionCount: data.extensionRecords?.length ?? prev?.extensionCount ?? 0,
      metaUpdateCount: metaUpdateCount ?? prev?.metaUpdateCount ?? 0,
    });
  }

  private getSessionFilePath(id: string): string {
    return path.join(KODAX_SESSIONS_DIR, `${id}.jsonl`);
  }

  private getArchiveFilePath(id: string): string {
    return path.join(KODAX_SESSIONS_DIR, `${id}.archive.jsonl`);
  }

  private async readSession(id: string): Promise<ResolvedSessionSnapshot | null> {
    const filePath = this.getSessionFilePath(id);
    const snapshot = await readPersistedSessionFile(filePath);
    if (!snapshot) {
      return null;
    }

    warnMalformedSessionData(filePath, snapshot.malformedCount);
    return buildSessionData(snapshot);
  }

  // ── Phase 2: Streaming write (no join) ──
  // Writes one JSONL line at a time via file handle, eliminating the giant
  // concatenated string that the old join('\n') approach produced.
  private async writeSessionInternal(
    id: string,
    data: SessionData,
    createdAt?: string,
  ): Promise<void> {
    await fs.mkdir(KODAX_SESSIONS_DIR, { recursive: true });

    const targetPath = this.getSessionFilePath(id);
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    const lineage = data.lineage ?? createSessionLineage(data.messages);
    const meta = createSessionMeta(id, data, lineage, createdAt);

    try {
      const handle = await fs.open(tempPath, 'w');
      try {
        await handle.write(JSON.stringify(meta) + '\n');
        for (const entry of lineage.entries) {
          await handle.write(JSON.stringify(toLineageEntryLine(entry)) + '\n');
        }
        for (const entry of (data.artifactLedger ?? [])) {
          await handle.write(JSON.stringify(toArtifactLedgerLine(entry)) + '\n');
        }
        for (const record of (data.extensionRecords ?? [])) {
          await handle.write(JSON.stringify(toExtensionRecordLine(record)) + '\n');
        }
      } finally {
        await handle.close();
      }
      await fs.rename(tempPath, targetPath);
    } finally {
      if (fsSync.existsSync(tempPath)) {
        await fs.unlink(tempPath).catch(() => undefined);
      }
    }
  }

  // ── Merge helper ──
  // Reads existing session, merges omitted fields (extensionState, runtimeInfo,
  // etc.), then does a full streamed write. Used by both save() and
  // appendSessionDelta fallback so that partially-populated data from
  // InkREPL.persistContextState never overwrites already-persisted fields.
  private async mergeAndWriteInternal(id: string, data: SessionData): Promise<void> {
    const existing = await this.readSession(id);
    const merged: SessionData = {
      ...data,
      scope: data.scope ?? existing?.data.scope ?? 'user',
      uiHistory: data.uiHistory ?? existing?.data.uiHistory,
      extensionState: data.extensionState ?? existing?.data.extensionState,
      artifactLedger: data.artifactLedger ?? existing?.data.artifactLedger,
      extensionRecords: data.extensionRecords ?? existing?.data.extensionRecords,
      runtimeInfo: data.runtimeInfo ?? existing?.data.runtimeInfo,
      errorMetadata: data.errorMetadata ?? existing?.data.errorMetadata,
      lineage: data.lineage ?? createSessionLineage(
        data.messages,
        existing?.data.lineage,
      ),
    };
    await this.writeSessionInternal(id, merged, existing?.createdAt);
    this.syncAppendState(id, merged);
  }

  // ── Phase 1: Append-only hot path ──
  // Only appends new entries + a meta_update line.  O(1) cost regardless of
  // total session size.  Falls back to full mergeAndWriteInternal when:
  //   - No cached watermark (process restart before load())
  //   - No file on disk (new session)
  //   - No lineage provided by caller
  //   - Watermark inconsistency (rewind/fork occurred)
  async appendSessionDelta(id: string, data: SessionData): Promise<void> {
    const filePath = this.getSessionFilePath(id);

    // Pre-checks that don't need serialization
    if (!fsSync.existsSync(filePath) || !data.lineage) {
      await this.save(id, data);
      return;
    }

    await this.serializedWrite(id, async () => {
      // Read latest watermark INSIDE the queue (not before entry)
      const cached = this.appendState.get(id);

      // No watermark → fallback
      if (!cached) {
        await this.mergeAndWriteInternal(id, data);
        return;
      }

      // Consistency: snapshot shrunk since last write → rewind/fork → fallback
      if (
        data.lineage!.entries.length < cached.lineageCount
        || (data.artifactLedger?.length ?? 0) < cached.artifactCount
      ) {
        await this.mergeAndWriteInternal(id, data);
        return;
      }

      // Compute delta
      const newLineage = data.lineage!.entries.slice(cached.lineageCount);
      const newArtifacts = (data.artifactLedger ?? []).slice(cached.artifactCount);
      const newExtensions = (data.extensionRecords ?? []).slice(cached.extensionCount);

      const parts: string[] = [];
      for (const entry of newLineage) {
        parts.push(JSON.stringify(toLineageEntryLine(entry)));
      }
      for (const entry of newArtifacts) {
        parts.push(JSON.stringify(toArtifactLedgerLine(entry)));
      }
      for (const record of newExtensions) {
        parts.push(JSON.stringify(toExtensionRecordLine(record)));
      }

      // meta_update: only include fields the caller actually provided
      const metaUpdate: PersistedMetaUpdateLine = {
        _type: 'meta_update',
        title: data.title,
        activeEntryId: data.lineage!.activeEntryId,
        activeMessageCount: countActiveLineageMessages(data.lineage!),
        ...(data.uiHistory !== undefined ? { uiHistory: data.uiHistory } : {}),
        ...(data.scope !== undefined ? { scope: data.scope } : {}),
      };
      parts.push(JSON.stringify(metaUpdate));

      if (parts.length > 0) {
        await fs.appendFile(filePath, '\n' + parts.join('\n'), 'utf-8');
      }

      // Update watermark inside the queue
      this.syncAppendState(id, data, cached.metaUpdateCount + 1);
    });

    // Async maintenance (also goes through serializedWrite, won't race with append)
    const state = this.appendState.get(id);
    if (state && this.shouldRunMaintenance(state)) {
      this.runMaintenance(id).catch((err) => {
        if (process.env.NODE_ENV !== 'test') {
          process.stderr.write(`[KodaX] Archive maintenance failed: ${String(err)}\n`);
        }
      });
    }
  }

  // ── Phase 3: Maintenance ──
  private shouldRunMaintenance(state: { metaUpdateCount: number; lineageCount: number }): boolean {
    if (state.metaUpdateCount >= 50) return true;
    if (state.lineageCount > 500) return true;
    return false;
  }

  private async runMaintenance(id: string): Promise<void> {
    await this.serializedWrite(id, async () => {
      // Re-read current session inside the queue (not a stale snapshot)
      const resolved = await this.readSession(id);
      if (!resolved?.data.lineage) return;

      const { slimmedLineage, archivedEntries, archiveBatchId } = archiveOldIslands(resolved.data.lineage);
      if (archivedEntries.length === 0) {
        // Nothing to archive, but still rewrite to merge meta_updates
        await this.writeSessionInternal(id, resolved.data, resolved.createdAt);
        this.syncAppendState(id, resolved.data, 0);
        return;
      }

      // Write sidecar (streaming append — no join)
      const archivePath = this.getArchiveFilePath(id);
      const archiveHandle = await fs.open(archivePath, 'a');
      try {
        await archiveHandle.write(JSON.stringify({
          _type: 'archive_batch',
          archiveBatchId,
          sessionId: id,
          archivedAt: new Date().toISOString(),
          entryCount: archivedEntries.length,
        }) + '\n');
        for (const entry of archivedEntries) {
          await archiveHandle.write(JSON.stringify({
            _type: 'archived_entry',
            archiveBatchId,
            entry,
          }) + '\n');
        }
      } finally {
        await archiveHandle.close();
      }

      // Full streamed rewrite of main session with slimmed lineage
      const cleanedData: SessionData = { ...resolved.data, lineage: slimmedLineage };
      await this.writeSessionInternal(id, cleanedData, resolved.createdAt);
      this.syncAppendState(id, cleanedData, 0);
    });
  }

  // ── Public API ──

  async save(id: string, data: SessionData): Promise<void> {
    await this.serializedWrite(id, async () => {
      await this.mergeAndWriteInternal(id, data);
    });
  }

  async load(id: string): Promise<SessionData | null> {
    const resolved = await this.readSession(id);
    if (!resolved) {
      return null;
    }

    // Initialize append watermark so subsequent appendSessionDelta calls
    // don't need to fallback to full rewrite.
    this.syncAppendState(id, resolved.data);

    const { data, createdAt } = resolved;
    const filePath = this.getSessionFilePath(id);

    const currentGitRoot = await getGitRoot();
    const currentRuntime = await inspectWorkspaceRuntime();
    const sessionRuntime = resolveSessionRuntimeInfo(data);
    const canonicalMismatch =
      currentRuntime.canonicalRepoRoot
      && sessionRuntime?.canonicalRepoRoot
      && !isSameCanonicalRepo(currentRuntime, sessionRuntime);

    if (canonicalMismatch || (currentGitRoot && data.gitRoot && currentGitRoot !== data.gitRoot && !isSameCanonicalRepo(
      currentRuntime,
      { canonicalRepoRoot: data.gitRoot },
    ))) {
      writeStorageNotice(chalk.yellow('\n[Warning] Session project mismatch:'));
      if (currentRuntime.workspaceRoot) {
        writeStorageNotice(`  Current workspace:  ${currentRuntime.workspaceRoot}`);
      }
      if (sessionRuntime?.workspaceRoot) {
        writeStorageNotice(`  Session workspace:  ${sessionRuntime.workspaceRoot}`);
      }
      if (currentRuntime.canonicalRepoRoot) {
        writeStorageNotice(`  Current repo:      ${currentRuntime.canonicalRepoRoot}`);
      }
      if (sessionRuntime?.canonicalRepoRoot) {
        writeStorageNotice(`  Session repo:      ${sessionRuntime.canonicalRepoRoot}`);
      } else if (data.gitRoot) {
        writeStorageNotice(`  Session repo:      ${data.gitRoot}`);
      }
      writeStorageNotice('  Continuing anyway...\n');
    }

    if (data.errorMetadata?.consecutiveErrors && data.errorMetadata.consecutiveErrors > 0) {
      const cleaned = cleanupIncompleteToolCalls(data.messages);
      if (cleaned !== data.messages) {
        writeStorageNotice(chalk.cyan('[Session Recovery] Cleaned incomplete tool calls from previous session'));
        const recovered: SessionData = {
          ...data,
          messages: cleaned,
          errorMetadata: {
            ...data.errorMetadata,
            consecutiveErrors: 0,
          },
          lineage: createSessionLineage(cleaned, data.lineage),
        };
        await this.serializedWrite(id, async () => {
          await this.writeSessionInternal(id, recovered, createdAt);
          this.syncAppendState(id, recovered);
        });
        return recovered;
      }
    }

    warnMalformedSessionData(filePath, 0);
    return data;
  }

  async getLineage(id: string): Promise<KodaXSessionLineage | null> {
    const resolved = await this.readSession(id);
    return resolved?.data.lineage ?? null;
  }

  async setActiveEntry(
    id: string,
    selector: string,
    options?: { summarizeCurrentBranch?: boolean },
  ): Promise<SessionData | null> {
    let result: SessionData | null = null;
    await this.serializedWrite(id, async () => {
      const resolved = await this.readSession(id);
      if (!resolved?.data.lineage) return;

      const lineage = setSessionLineageActiveEntry(
        resolved.data.lineage,
        selector,
        options,
      );
      if (!lineage) return;

      const nextData: SessionData = {
        ...resolved.data,
        messages: getSessionMessagesFromLineage(lineage),
        lineage,
      };
      await this.writeSessionInternal(id, nextData, resolved.createdAt);
      this.syncAppendState(id, nextData);
      result = nextData;
    });
    return result;
  }

  async rewind(id: string, selector?: string): Promise<SessionData | null> {
    let result: SessionData | null = null;
    await this.serializedWrite(id, async () => {
      const resolved = await this.readSession(id);
      if (!resolved?.data.lineage) return;

      const targetId = selector ?? findPreviousUserEntryId(resolved.data.lineage);
      if (!targetId) return;

      const lineage = rewindSessionLineage(resolved.data.lineage, targetId);
      if (!lineage) return;

      const nextData: SessionData = {
        ...resolved.data,
        messages: getSessionMessagesFromLineage(lineage),
        lineage,
      };
      await this.writeSessionInternal(id, nextData, resolved.createdAt);
      this.syncAppendState(id, nextData);
      result = nextData;
    });
    return result;
  }

  async setLabel(id: string, selector: string, label?: string): Promise<SessionData | null> {
    let result: SessionData | null = null;
    await this.serializedWrite(id, async () => {
      const resolved = await this.readSession(id);
      if (!resolved?.data.lineage) return;

      const lineage = appendSessionLineageLabel(resolved.data.lineage, selector, label);
      if (!lineage) return;

      const nextData: SessionData = {
        ...resolved.data,
        lineage,
      };
      await this.writeSessionInternal(id, nextData, resolved.createdAt);
      this.syncAppendState(id, nextData);
      result = nextData;
    });
    return result;
  }

  async fork(
    id: string,
    selector?: string,
    options?: { sessionId?: string; title?: string },
  ): Promise<{ sessionId: string; data: SessionData } | null> {
    let result: { sessionId: string; data: SessionData } | null = null;
    // Serialize on the SOURCE session (the one being read)
    await this.serializedWrite(id, async () => {
      const resolved = await this.readSession(id);
      if (!resolved?.data.lineage) return;

      const lineage = forkSessionLineage(resolved.data.lineage, selector);
      if (!lineage) return;

      const sessionId = options?.sessionId ?? await generateSessionId();
      const forked: SessionData = {
        messages: getSessionMessagesFromLineage(lineage),
        title: options?.title ?? resolved.data.title,
        gitRoot: resolved.data.gitRoot,
        uiHistory: resolved.data.uiHistory
          ? resolved.data.uiHistory.map((item) => ({ ...item }))
          : undefined,
        extensionState: resolved.data.extensionState
          ? structuredClone(resolved.data.extensionState)
          : undefined,
        artifactLedger: resolved.data.artifactLedger
          ? structuredClone(resolved.data.artifactLedger)
          : undefined,
        extensionRecords: resolved.data.extensionRecords
          ? structuredClone(resolved.data.extensionRecords)
          : undefined,
        lineage,
      };
      // Fork writes to a NEW session id — serialize on that id too
      await this.writeSessionInternal(sessionId, forked);
      result = { sessionId, data: forked };
    });
    return result;
  }

  async list(gitRoot?: string): Promise<Array<{
    id: string;
    title: string;
    msgCount: number;
    runtimeInfo?: KodaXSessionRuntimeInfo;
  }>> {
    await fs.mkdir(KODAX_SESSIONS_DIR, { recursive: true });
    const currentGitRoot = gitRoot ?? await getGitRoot();
    const currentRuntime = await inspectWorkspaceRuntime({
      cwd: currentGitRoot ?? process.cwd(),
    });
    const files = (await fs.readdir(KODAX_SESSIONS_DIR)).filter((file) => file.endsWith('.jsonl'));
    const sessions: Array<{
      id: string;
      title: string;
      msgCount: number;
      createdAt?: string;
      runtimeInfo?: KodaXSessionRuntimeInfo;
    }> = [];

    for (const file of files) {
      try {
        const content = (await fs.readFile(path.join(KODAX_SESSIONS_DIR, file), 'utf-8')).trim();
        const firstLine = content.split('\n')[0];
        if (!firstLine) {
          continue;
        }

        const first = JSON.parse(firstLine);
        if (isRecord(first) && first._type === 'meta') {
          const sessionGitRoot = typeof first.gitRoot === 'string' ? first.gitRoot : '';
          const sessionRuntime = isKodaXSessionRuntimeInfo(first.runtimeInfo)
            ? first.runtimeInfo
            : undefined;
          const scope: KodaXSessionScope = first.scope === 'managed-task-worker'
            ? 'managed-task-worker'
            : 'user';
          if (currentGitRoot) {
            const sameCanonicalRepo = isSameCanonicalRepo(currentRuntime, sessionRuntime);
            const sameWorkspace = sessionRuntime?.workspaceRoot
              ? sessionRuntime.workspaceRoot === currentRuntime.workspaceRoot
              : sessionGitRoot === currentGitRoot;
            if (!sameCanonicalRepo && !sameWorkspace) {
              continue;
            }
          }
          if (scope !== 'user') {
            continue;
          }

          const lineCount = content.split('\n').length;
          const extensionRecordCount =
            typeof first.extensionRecordCount === 'number' && first.extensionRecordCount > 0
              ? first.extensionRecordCount
              : 0;
          const activeMessageCount =
            typeof first.activeMessageCount === 'number' && first.activeMessageCount >= 0
              ? first.activeMessageCount
              : Math.max(0, lineCount - 1 - extensionRecordCount);
          sessions.push({
            id: file.replace('.jsonl', ''),
            title: typeof first.title === 'string' ? first.title : '',
            msgCount: activeMessageCount,
            createdAt: typeof first.createdAt === 'string' ? first.createdAt : undefined,
            runtimeInfo: sessionRuntime ? { ...sessionRuntime } : undefined,
          });
        } else {
          const lineCount = content.split('\n').length;
          sessions.push({ id: file.replace('.jsonl', ''), title: '', msgCount: lineCount });
        }
      } catch {
        continue;
      }
    }

    return sessions
      .sort((left, right) => {
        const leftTime = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
        const rightTime = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
          return rightTime - leftTime;
        }
        if (Number.isFinite(rightTime) && !Number.isFinite(leftTime)) {
          return 1;
        }
        if (Number.isFinite(leftTime) && !Number.isFinite(rightTime)) {
          return -1;
        }
        return right.id.localeCompare(left.id);
      })
      .slice(0, 10)
      .map(({ id, title, msgCount, runtimeInfo }) => (
        runtimeInfo
          ? { id, title, msgCount, runtimeInfo }
          : { id, title, msgCount }
      ));
  }

  async delete(id: string): Promise<void> {
    const filePath = this.getSessionFilePath(id);
    if (fsSync.existsSync(filePath)) {
      await fs.unlink(filePath);
    }
  }

  async deleteAll(gitRoot?: string): Promise<void> {
    const currentGitRoot = gitRoot ?? await getGitRoot();
    const sessions = await this.list(currentGitRoot ?? undefined);
    for (const session of sessions) {
      await this.delete(session.id);
    }
  }
}
