/**
 * FEATURE_308 — the session evidence the reflection job still owes a pass, kept on
 * disk under `<root>/.pending-reflection/` so nothing a session showed is lost to
 * the "read again after a few more turns" cadence, an exit, a crash or a failed
 * call. A run end that passes the gate saves its evidence before any judge call;
 * a successful pass removes it.
 *
 * A live record is the latest view of a session that may still grow, one file per
 * session. When compaction drops turns from a session, its live record is frozen:
 * it keeps the turns compaction removed and no longer moves the session's cursor.
 * Two processes may drain the same record; corroborate refuses a note's own
 * session, so a second pass cannot promote anything on its own.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { SessionEvidence } from './evidence.js';
import { atomicWrite, isNotFound, readOrUndefined } from './fs-util.js';
import { parseStateFile } from './state-file.js';

export const PENDING_DIR = '.pending-reflection';
/** Another session's live record is taken over once it has been quiet this long. */
export const PENDING_IDLE_MS = 30 * 60 * 1000;
const PENDING_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface PendingReflection {
  readonly sessionId: string;
  readonly project?: string;
  /** When the evidence was saved. */
  readonly at: number;
  readonly userTurns: number;
  /** Set when compaction cut the session: this copy no longer grows and moves no cursor. */
  readonly frozen?: boolean;
  readonly evidence: SessionEvidence;
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 24);

function fileOf(root: string, record: Pick<PendingReflection, 'sessionId' | 'at' | 'frozen'>): string {
  const name = record.frozen === true ? `frozen-${hashOf(record.sessionId)}-${record.at}.json` : `live-${hashOf(record.sessionId)}.json`;
  return path.join(root, PENDING_DIR, name);
}

function isEvidence(value: unknown): value is SessionEvidence {
  const { segments, userText, omitted } = (value ?? {}) as Record<string, unknown>;
  return Array.isArray(segments) && typeof userText === 'string' && typeof omitted === 'number';
}

function recordOf(value: unknown): PendingReflection | undefined {
  const { sessionId, project, at, userTurns, frozen, evidence } = (value ?? {}) as Record<string, unknown>;
  if (typeof sessionId !== 'string' || typeof at !== 'number' || typeof userTurns !== 'number' || !isEvidence(evidence)) return undefined;
  return {
    sessionId,
    ...(typeof project === 'string' ? { project } : {}),
    at,
    userTurns,
    ...(frozen === true ? { frozen: true } : {}),
    evidence,
  };
}

async function readRecord(file: string): Promise<PendingReflection | undefined> {
  return recordOf(parseStateFile(file, await readOrUndefined(file)));
}

export async function savePending(root: string, record: PendingReflection): Promise<void> {
  await fs.mkdir(path.join(root, PENDING_DIR), { recursive: true });
  await atomicWrite(fileOf(root, record), JSON.stringify(record));
}

/** The session's live record, if it has one. */
export async function livePending(root: string, sessionId: string): Promise<PendingReflection | undefined> {
  return readRecord(fileOf(root, { sessionId, at: 0 }));
}

/** Compaction cut the session: keep its last evidence as a frozen record of its own. */
export async function freezePending(root: string, sessionId: string): Promise<void> {
  const live = fileOf(root, { sessionId, at: 0 });
  const record = await readRecord(live);
  if (record === undefined) return;
  await savePending(root, { ...record, frozen: true });
  await fs.rm(live, { force: true });
}

/** Every readable record, oldest first. Unreadable and expired files are removed. */
export async function listPending(root: string, now: number = Date.now()): Promise<PendingReflection[]> {
  const dir = path.join(root, PENDING_DIR);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const records: PendingReflection[] = [];
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    const file = path.join(dir, name);
    const record = await readRecord(file);
    if (record === undefined || now - record.at > PENDING_RETENTION_MS) await fs.rm(file, { force: true });
    else records.push(record);
  }
  return records.sort((a, b) => a.at - b.at);
}

/** Removes the record unless the session saved newer evidence in the meantime. */
export async function removePending(root: string, record: PendingReflection): Promise<void> {
  const file = fileOf(root, record);
  if ((await readRecord(file))?.at === record.at) await fs.rm(file, { force: true });
}
