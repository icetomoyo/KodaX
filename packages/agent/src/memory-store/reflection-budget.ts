/**
 * FEATURE_306 — the reflection job's cost cap: a fixed number of judge calls per
 * calendar day, counted in `<root>/.reflection-budget.json`. A slot is taken
 * before the call, so a failing provider cannot be retried past the cap.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWrite, readOrUndefined } from './fs-util.js';
import { parseStateFile } from './state-file.js';

export const BUDGET_FILE = '.reflection-budget.json';
export const DAILY_REFLECTION_CALLS = 10;

interface Day {
  readonly day: string;
  readonly calls: number;
}

async function load(file: string): Promise<Day | undefined> {
  const parsed = parseStateFile(file, await readOrUndefined(file));
  const { day, calls } = (parsed ?? {}) as Record<string, unknown>;
  return typeof day === 'string' && typeof calls === 'number' ? { day, calls } : undefined;
}

/** Takes one of today's slots; false when the day's cap is spent. */
export async function takeReflectionSlot(root: string, now: Date = new Date(), cap: number = DAILY_REFLECTION_CALLS): Promise<boolean> {
  const file = path.join(root, BUDGET_FILE);
  const today = now.toISOString().slice(0, 10);
  const current = await load(file);
  const calls = current?.day === today ? current.calls : 0;
  if (calls >= cap) return false;
  await fs.mkdir(root, { recursive: true });
  await atomicWrite(file, JSON.stringify({ day: today, calls: calls + 1 }));
  return true;
}
