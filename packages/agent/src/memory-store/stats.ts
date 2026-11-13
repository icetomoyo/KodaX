/**
 * FEATURE_306 — local usage counters, so whether memory helps can be judged
 * from real use and not only from staged evals. Plain totals in
 * `<root>/.memory-stats.json`; nothing leaves the machine.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWrite, readOrUndefined } from './fs-util.js';
import type { ReflectionOpInput } from './reflection-op.js';
import { parseStateFile } from './state-file.js';

export const STATS_FILE = '.memory-stats.json';

/** Note reads, reflection calls, and each kind of reflection change that was applied or refused. */
export type MemoryStatName = 'reads' | 'reflections' | 'rejected' | ReflectionOpInput['operation'];

export type MemoryStats = { readonly since: string } & Partial<Record<MemoryStatName, number>>;

export async function readMemoryStats(root: string): Promise<MemoryStats | undefined> {
  const file = path.join(root, STATS_FILE);
  const parsed = parseStateFile(file, await readOrUndefined(file));
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.since !== 'string') return undefined;
  const counts = Object.fromEntries(Object.entries(record).filter(([, value]) => typeof value === 'number'));
  return { ...counts, since: record.since };
}

/** Adds to the totals; zero deltas write nothing. */
export async function addMemoryStats(root: string, delta: Partial<Record<MemoryStatName, number>>, now: Date = new Date()): Promise<void> {
  const changes = Object.entries(delta).filter(([, value]) => value !== undefined && value > 0) as [MemoryStatName, number][];
  if (changes.length === 0) return;
  const current: Record<string, number | string> = { ...(await readMemoryStats(root) ?? { since: now.toISOString() }) };
  for (const [name, value] of changes) {
    const before = current[name];
    current[name] = (typeof before === 'number' ? before : 0) + value;
  }
  await fs.mkdir(root, { recursive: true });
  await atomicWrite(path.join(root, STATS_FILE), JSON.stringify(current));
}
