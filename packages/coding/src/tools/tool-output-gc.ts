/**
 * FEATURE_121 v0.7.40 — explicit TTL cleanup helper for legacy tool-output
 * spillover files plus production reference-aware cleanup.
 *
 * `persistToolOutput` (`./truncate.ts`) writes large tool outputs (read /
 * grep / bash / child-task spillover) to `~/.kodax/tool-results/<file>.txt`.
 * Recovery artifacts can be referenced by resumable session history. Age alone
 * cannot prove that an artifact is dead, so `persistToolOutput` never runs an
 * age-only sweep. Production callers supply the complete live-reference set;
 * the legacy age-only helper remains an explicit host/operator action.
 *
 * Design:
 *   - 14-day TTL remains the legacy/manual default, not a liveness claim.
 *   - Reference-aware cleanup retains every path named by resumable sessions.
 *   - Optional throttling coalesces calls made by a host.
 *   - Per-file IO failures are returned in the result summary.
 *   - Stateless across processes: the cooldown lives in a module-level
 *     variable. Process restart resets it. No `.last-gc` marker file
 *     (that would just be another file to manage).
 *
 * Tested at `./tool-output-gc.test.ts`.
 */

import fs from 'fs/promises';
import path from 'path';
import { withFileMutation } from './_internal/file-mutation-queue.js';

/** Legacy/manual retention default. Callers must establish artifact liveness. */
export const DEFAULT_TOOL_OUTPUT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** 1-hour in-process cooldown for `maybeRunToolOutputGc`. */
export const GC_COOLDOWN_MS = 60 * 60 * 1000;

export interface ToolOutputGcResult {
  /** Files inspected (including those not yet expired). */
  readonly scanned: number;
  /** Files deleted because they exceeded the TTL. */
  readonly removed: number;
  /** Files that failed to stat or unlink (IO error). */
  readonly failed: number;
  /** Total bytes reclaimed. */
  readonly bytesRemoved: number;
}

export interface ToolOutputStorageUsage {
  readonly status: 'complete' | 'partial' | 'missing';
  readonly files: number;
  readonly bytes: number;
  /** Flat namespace only; child namespaces require their own inspection. */
  readonly directories: number;
  readonly failed: number;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Explicit read-only capacity inspection, never a liveness proof or an automatic sweep. */
export async function inspectToolOutputStorage(dir: string): Promise<ToolOutputStorageUsage> {
  let names: string[];
  try { names = await fs.readdir(dir); }
  catch (error: unknown) { return { status: isMissing(error) ? 'missing' : 'partial', files: 0, bytes: 0, directories: 0, failed: isMissing(error) ? 0 : 1 }; }
  let files = 0, bytes = 0, directories = 0, failed = 0;
  for (const name of names) {
    try {
      const stat = await fs.lstat(path.join(dir, name));
      if (stat.isFile()) { files++; bytes += stat.size; }
      else if (stat.isDirectory()) directories++;
      else failed++; // Do not follow aliases into another storage namespace.
    } catch { failed++; }
  }
  return { status: failed ? 'partial' : 'complete', files, bytes, directories, failed };
}

/**
 * Walk `dir` once and unlink any regular file whose mtime is older than
 * `now - ttlMs`. Subdirectories are ignored (defensive: a future feature
 * may want to namespace by session — leaving directories untouched lets
 * that work coexist with TTL cleanup of legacy flat files).
 *
 * Returns a count summary. Never throws — directory-missing / per-file
 * IO errors are swallowed and reported via `failed`.
 */
export async function cleanupExpiredToolOutputs(
  dir: string,
  ttlMs: number = DEFAULT_TOOL_OUTPUT_TTL_MS,
  now: number = Date.now(),
): Promise<ToolOutputGcResult> {
  return withFileMutation(dir, () => cleanupExpiredToolOutputsInPlace(dir, ttlMs, now))
    .catch(() => ({ scanned: 0, removed: 0, failed: 1, bytesRemoved: 0 }));
}

async function cleanupExpiredToolOutputsInPlace(
  dir: string,
  ttlMs: number,
  now: number,
): Promise<ToolOutputGcResult> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error: unknown) {
    return { scanned: 0, removed: 0, failed: isMissing(error) ? 0 : 1, bytesRemoved: 0 };
  }

  let scanned = 0;
  let removed = 0;
  let failed = 0;
  let bytesRemoved = 0;

  for (const name of entries) {
    const filePath = path.join(dir, name);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      failed += 1;
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    scanned += 1;
    const ageMs = now - stat.mtimeMs;
    if (ageMs <= ttlMs) {
      continue;
    }
    try {
      await fs.unlink(filePath);
      removed += 1;
      bytesRemoved += stat.size;
    } catch {
      failed += 1;
    }
  }

  return { scanned, removed, failed, bytesRemoved };
}

function normalizeArtifactPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Production-safe sweep: age is only a grace gate; a referenced artifact is
 * retained regardless of age. The operator must stop writers and supply the
 * complete reference closure from every SDK/Host storage root sharing this
 * namespace, including manifest/stream dependencies. Unknown scope means retain.
 */
export async function cleanupUnreferencedToolOutputs(
  dir: string,
  referencedPaths: ReadonlySet<string>,
  graceMs: number = DEFAULT_TOOL_OUTPUT_TTL_MS,
  now: number = Date.now(),
): Promise<ToolOutputGcResult> {
  return withFileMutation(
    dir,
    () => cleanupUnreferencedToolOutputsInPlace(dir, referencedPaths, graceMs, now),
  ).catch(() => ({ scanned: 0, removed: 0, failed: 1, bytesRemoved: 0 }));
}

async function cleanupUnreferencedToolOutputsInPlace(
  dir: string,
  referencedPaths: ReadonlySet<string>,
  graceMs: number,
  now: number,
): Promise<ToolOutputGcResult> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error: unknown) {
    return { scanned: 0, removed: 0, failed: isMissing(error) ? 0 : 1, bytesRemoved: 0 };
  }

  const referenced = new Set([...referencedPaths].map(normalizeArtifactPath));
  let scanned = 0;
  let removed = 0;
  let failed = 0;
  let bytesRemoved = 0;
  for (const name of entries) {
    const filePath = path.join(dir, name);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      scanned += 1;
      if (referenced.has(normalizeArtifactPath(filePath)) || now - stat.mtimeMs <= graceMs) continue;
      await fs.unlink(filePath);
      removed += 1;
      bytesRemoved += stat.size;
    } catch {
      failed += 1;
    }
  }
  return { scanned, removed, failed, bytesRemoved };
}

// Hosts may manage multiple storage roots in one process.
const gcStates = new Map<string, { lastGcAtMs: number; inFlight: Promise<ToolOutputGcResult | null> | null }>();
function stateFor(dir: string) {
  const key = normalizeArtifactPath(dir);
  let state = gcStates.get(key);
  if (!state) { state = { lastGcAtMs: 0, inFlight: null }; gcStates.set(key, state); }
  return state;
}

/**
 * Throttled wrapper for an explicit host/operator cleanup request. It is not
 * called by `persistToolOutput`. Returns:
 *   - the GC result promise if this call actually launched a sweep, OR
 *   - `null` if the cooldown is still in effect (no sweep launched).
 *
 * Callers may await the result when they need an auditable cleanup summary.
 */
export function maybeRunToolOutputGc(
  dir: string,
  ttlMs: number = DEFAULT_TOOL_OUTPUT_TTL_MS,
  now: number = Date.now(),
): Promise<ToolOutputGcResult | null> {
  const state = stateFor(dir);
  if (state.inFlight) {
    return state.inFlight;
  }
  if (now - state.lastGcAtMs < GC_COOLDOWN_MS) {
    return Promise.resolve(null);
  }
  state.lastGcAtMs = now;
  state.inFlight = cleanupExpiredToolOutputs(dir, ttlMs, now)
    .then((result) => {
      state.inFlight = null;
      return result;
    })
    .catch(() => {
      state.inFlight = null;
      return null;
    });
  return state.inFlight;
}

/**
 * Throttled production entry point. Reference discovery happens only after the
 * cooldown admits a sweep; discovery failure cancels deletion fail-closed.
 */
export function maybeRunReferenceAwareToolOutputGc(
  dir: string,
  loadReferencedPaths: () => Promise<ReadonlySet<string>>,
  graceMs: number = DEFAULT_TOOL_OUTPUT_TTL_MS,
  now: number = Date.now(),
): Promise<ToolOutputGcResult | null> {
  const state = stateFor(dir);
  if (state.inFlight) return state.inFlight;
  if (now - state.lastGcAtMs < GC_COOLDOWN_MS) return Promise.resolve(null);
  state.lastGcAtMs = now;
  state.inFlight = loadReferencedPaths()
    .then((referenced) => cleanupUnreferencedToolOutputs(dir, referenced, graceMs, now))
    .then((result) => {
      state.inFlight = null;
      return result;
    })
    .catch(() => {
      state.inFlight = null;
      return null;
    });
  return state.inFlight;
}

/** Test hook — resets the cooldown so each test starts from a clean slate. */
export function __resetGcCooldownForTests(): void {
  gcStates.clear();
}
