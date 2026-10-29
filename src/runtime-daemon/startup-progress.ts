import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { ClientHostStartupPhase } from '@kodax-ai/coding/client-contract';

export const DAEMON_STARTUP_PROGRESS_ENV = 'KODAX_INTERNAL_DAEMON_STARTUP_PROGRESS_ID';
const PREFIX = '[kodax-startup] ';
const PHASES: readonly ClientHostStartupPhase[] = [
  'modules', 'extensions', 'runtime', 'recovery', 'mcp', 'sessions', 'a2a', 'listener',
];

/** A few display-only records in the existing bootstrap log; no readiness authority. */
export function reportDaemonStartupPhase(phase: ClientHostStartupPhase): void {
  const startupId = process.env[DAEMON_STARTUP_PROGRESS_ENV];
  if (!startupId || process.env.KODAX_DAEMON_SERVE !== '1') return;
  try {
    process.stderr.write(`\n${PREFIX}${JSON.stringify({ startupId, pid: process.pid, phase, time: new Date().toISOString() })}\n`);
  } catch (error: unknown) {
    process.emitWarning(error instanceof Error ? error : String(error), { code: 'KODAX_STARTUP_PROGRESS' });
  }
}

/** Read at most 4 KiB during an existing startup poll, including partially written logs. */
export function readDaemonStartupPhase(file: string, startupId: string, pid: number): ClientHostStartupPhase | undefined {
  let descriptor: number;
  try { descriptor = openSync(file, 'r'); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  try {
    const size = fstatSync(descriptor).size;
    const tail = Buffer.alloc(Math.min(size, 4096));
    const count = readSync(descriptor, tail, 0, tail.length, size - tail.length);
    for (const line of tail.subarray(0, count).toString('utf8').split('\n').reverse()) {
      if (!line.startsWith(PREFIX)) continue;
      let value: unknown;
      try { value = JSON.parse(line.slice(PREFIX.length)); }
      catch { continue; } // The writer may be between writes; logs are not authoritative state.
      if (typeof value !== 'object' || value === null || !('startupId' in value) || !('pid' in value) || !('phase' in value)) continue;
      if (value.startupId === startupId && value.pid === pid && PHASES.includes(value.phase as ClientHostStartupPhase)) {
        return value.phase as ClientHostStartupPhase;
      }
    }
  } finally {
    closeSync(descriptor);
  }
}
