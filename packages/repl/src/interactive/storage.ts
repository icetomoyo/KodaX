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
  KodaXSessionScope,
  KodaXSessionStorage,
} from '@kodax/coding';
import {
  appendSessionLineageLabel,
  cleanupIncompleteToolCalls,
  countActiveLineageMessages,
  createSessionLineage,
  forkSessionLineage,
  generateSessionId,
  getSessionMessagesFromLineage,
  setSessionLineageActiveEntry,
} from '@kodax/coding';
import type { SessionData, SessionErrorMetadata } from '../ui/utils/session-storage.js';
import { getGitRoot, KODAX_SESSIONS_DIR } from '../common/utils.js';
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
      entries: snapshot.lineageEntries.map((entry) => structuredClone(entry)),
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
          : snapshot.legacyMessages.map((message) => structuredClone(message)),
        title: snapshot.meta?.title ?? '',
        gitRoot: snapshot.meta?.gitRoot ?? '',
        scope: snapshot.meta?.scope ?? 'user',
        uiHistory: isKodaXSessionUiHistory(snapshot.meta?.uiHistory)
          ? snapshot.meta.uiHistory.map((item) => ({ ...item }))
          : undefined,
        errorMetadata: isSessionErrorMetadata(snapshot.meta?.errorMetadata)
          ? snapshot.meta?.errorMetadata
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

      if (isPersistedLineageEntryLine(parsed)) {
        snapshot.lineageEntries.push(structuredClone(parsed.entry));
        continue;
      }

      if (isPersistedArtifactLedgerLine(parsed)) {
        snapshot.artifactLedger.push({
          ...parsed.entry,
          metadata: parsed.entry.metadata ? structuredClone(parsed.entry.metadata) : undefined,
        });
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
        snapshot.legacyMessages.push(structuredClone(parsed));
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
  private getSessionFilePath(id: string): string {
    return path.join(KODAX_SESSIONS_DIR, `${id}.jsonl`);
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

  private async writeSession(
    id: string,
    data: SessionData,
    createdAt?: string,
  ): Promise<void> {
    await fs.mkdir(KODAX_SESSIONS_DIR, { recursive: true });

    const targetPath = this.getSessionFilePath(id);
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    const lineage = data.lineage
      ? createSessionLineage(data.messages, data.lineage)
      : createSessionLineage(data.messages);
    const meta = createSessionMeta(id, data, lineage, createdAt);
    const lineageLines = lineage.entries.map((entry) => JSON.stringify(toLineageEntryLine(entry)));
    const artifactLedgerLines = (data.artifactLedger ?? [])
      .map((entry) => JSON.stringify(toArtifactLedgerLine(entry)));
    const extensionRecordLines = (data.extensionRecords ?? [])
      .map((record) => JSON.stringify(toExtensionRecordLine(record)));
    const lines = [JSON.stringify(meta), ...lineageLines, ...artifactLedgerLines, ...extensionRecordLines];

    try {
      await fs.writeFile(
        tempPath,
        lines.join('\n'),
        'utf-8',
      );
      await fs.rename(tempPath, targetPath);
    } finally {
      if (fsSync.existsSync(tempPath)) {
        await fs.unlink(tempPath).catch(() => undefined);
      }
    }
  }

  async save(id: string, data: SessionData): Promise<void> {
    const existing = await this.readSession(id);
    const merged: SessionData = {
      ...data,
      scope: data.scope ?? existing?.data.scope ?? 'user',
      uiHistory: data.uiHistory ?? existing?.data.uiHistory,
      extensionState: data.extensionState ?? existing?.data.extensionState,
      artifactLedger: data.artifactLedger ?? existing?.data.artifactLedger,
      extensionRecords: data.extensionRecords ?? existing?.data.extensionRecords,
      lineage: createSessionLineage(
        data.messages,
        data.lineage ?? existing?.data.lineage,
      ),
    };
    await this.writeSession(id, merged, existing?.createdAt);
  }

  async load(id: string): Promise<SessionData | null> {
    const resolved = await this.readSession(id);
    if (!resolved) {
      return null;
    }

    const { data, createdAt } = resolved;
    const filePath = this.getSessionFilePath(id);

    const currentGitRoot = await getGitRoot();
    if (currentGitRoot && data.gitRoot && currentGitRoot !== data.gitRoot) {
      writeStorageNotice(chalk.yellow('\n[Warning] Session project mismatch:'));
      writeStorageNotice(`  Current:  ${currentGitRoot}`);
      writeStorageNotice(`  Session:  ${data.gitRoot}`);
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
        await this.writeSession(id, recovered, createdAt);
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
    const resolved = await this.readSession(id);
    if (!resolved?.data.lineage) {
      return null;
    }

    const lineage = setSessionLineageActiveEntry(
      resolved.data.lineage,
      selector,
      options,
    );
    if (!lineage) {
      return null;
    }

    const nextData: SessionData = {
      ...resolved.data,
      messages: getSessionMessagesFromLineage(lineage),
      lineage,
    };
    await this.writeSession(id, nextData, resolved.createdAt);
    return nextData;
  }

  async setLabel(id: string, selector: string, label?: string): Promise<SessionData | null> {
    const resolved = await this.readSession(id);
    if (!resolved?.data.lineage) {
      return null;
    }

    const lineage = appendSessionLineageLabel(resolved.data.lineage, selector, label);
    if (!lineage) {
      return null;
    }

    const nextData: SessionData = {
      ...resolved.data,
      lineage,
    };
    await this.writeSession(id, nextData, resolved.createdAt);
    return nextData;
  }

  async fork(
    id: string,
    selector?: string,
    options?: { sessionId?: string; title?: string },
  ): Promise<{ sessionId: string; data: SessionData } | null> {
    const resolved = await this.readSession(id);
    if (!resolved?.data.lineage) {
      return null;
    }

    const lineage = forkSessionLineage(resolved.data.lineage, selector);
    if (!lineage) {
      return null;
    }

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
    await this.writeSession(sessionId, forked);
    return {
      sessionId,
      data: forked,
    };
  }

  async list(gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>> {
    await fs.mkdir(KODAX_SESSIONS_DIR, { recursive: true });
    const currentGitRoot = gitRoot ?? await getGitRoot();
    const files = (await fs.readdir(KODAX_SESSIONS_DIR)).filter((file) => file.endsWith('.jsonl'));
    const sessions: Array<{
      id: string;
      title: string;
      msgCount: number;
      createdAt?: string;
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
          const scope: KodaXSessionScope = first.scope === 'managed-task-worker'
            ? 'managed-task-worker'
            : 'user';
          if (currentGitRoot) {
            if (!sessionGitRoot || sessionGitRoot !== currentGitRoot) {
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
      .map(({ id, title, msgCount }) => ({ id, title, msgCount }));
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
