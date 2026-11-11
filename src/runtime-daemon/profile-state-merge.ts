import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import { MAX_QUEUED_INPUTS } from '../session-input-queue.js';
import { RUNTIME_HOST_SLOT, readRuntimeDaemonLockOwner, resolveRuntimeDaemonPathsFromConfigHome, runtimeOwnerProcessState } from './state.js';

/**
 * One-time merge of legacy Host profile state (`runtime/profiles/<p>/`) into
 * the canonical profile (ADR-075, design §4.3). The canonical Host runs it
 * while it owns Session storage, so no other Host writes these files. Every
 * rule is idempotent: a crash before the legacy profile is retired reruns it.
 */
export type RuntimeProfileMergeReport =
  | { readonly profile: string; readonly skipped: 'live_host' }
  | {
    readonly profile: string;
    /** The retired directory name; absent while a failed item keeps the profile in place. */
    readonly mergedTo?: string;
    readonly moved: number;
    readonly conflicts: readonly string[];
    readonly importedGrants: number;
    /** Grants without a Session scope; importing them would widen approvals to every client (Q2). */
    readonly droppedGlobalGrants: number;
    /** Unknown entries kept in the retired directory until retention expires it. */
    readonly retained: readonly string[];
    readonly failed: readonly { readonly item: string; readonly error: string }[];
  };

type GrantParser = (value: unknown) => { readonly id: string; readonly scope: { readonly sessionId?: string } };

interface MergeState {
  moved: number;
  runsMoved: boolean;
  importedGrants: number;
  droppedGlobalGrants: number;
  readonly conflicts: string[];
  readonly failed: { item: string; error: string }[];
}

const LEGACY_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RETIRED_PROFILE = /\.merged-\d{8}(?:-\d+)?$/;

export function mergeLegacyRuntimeProfileState(
  configHome: string,
  parseGrant: GrantParser,
  now = new Date(),
): readonly RuntimeProfileMergeReport[] {
  const profilesDir = path.join(path.resolve(configHome), 'runtime', 'profiles');
  const reports: RuntimeProfileMergeReport[] = [];
  try {
    for (const profile of legacyProfiles(profilesDir)) {
      reports.push(mergeProfile(configHome, profilesDir, profile, parseGrant, now));
    }
  } catch (error: unknown) {
    emitKodaXDiagnostic({ source: 'runtime.host.state-merged', level: 'warn',
      message: 'Legacy Host profile state could not be listed; it stays in place for the next startup.',
      detail: { error: errorMessage(error), profiles: reports } });
    return reports;
  }
  if (reports.length > 0) {
    const failed = reports.some(report => 'failed' in report && report.failed.length > 0);
    emitKodaXDiagnostic({ source: 'runtime.host.state-merged', level: failed ? 'warn' : 'info',
      message: 'Merged legacy Host profile state into the canonical profile (ADR-075).', detail: { profiles: reports } });
  }
  return reports;
}

function legacyProfiles(profilesDir: string): string[] {
  if (!fs.existsSync(profilesDir)) return [];
  return fs.readdirSync(profilesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== RUNTIME_HOST_SLOT
      && LEGACY_PROFILE.test(entry.name) && !RETIRED_PROFILE.test(entry.name))
    .map(entry => entry.name).sort();
}

function mergeProfile(configHome: string, profilesDir: string, profile: string, parseGrant: GrantParser, now: Date): RuntimeProfileMergeReport {
  const owner = readRuntimeDaemonLockOwner(resolveRuntimeDaemonPathsFromConfigHome(configHome, profile).lockFile);
  if (owner && runtimeOwnerProcessState(owner) !== 'gone') return { profile, skipped: 'live_host' };
  const source = path.join(profilesDir, profile);
  const target = path.join(profilesDir, RUNTIME_HOST_SLOT);
  const state: MergeState = { moved: 0, runsMoved: false, importedGrants: 0, droppedGlobalGrants: 0, conflicts: [], failed: [] };
  const retained: string[] = [];
  // Root files such as the grant store are written before `runs/` would create it.
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(source).sort()) {
    const merge = ENTRY_MERGERS[name];
    if (merge) merge(path.join(source, name), path.join(target, name), state, parseGrant);
    else if (name !== 'run-status-index.json') retained.push(name);
  }
  // The fail-closed scan rebuilds the index from the merged Runs.
  if (state.runsMoved) attempt(state, 'run-status-index.json', () => fs.rmSync(path.join(target, 'run-status-index.json'), { force: true }));
  const mergedTo = state.failed.length === 0 ? retire(source, profile, now, state) : undefined;
  const { moved, conflicts, importedGrants, droppedGlobalGrants, failed } = state;
  return { profile, ...(mergedTo ? { mergedTo } : {}), moved, conflicts, importedGrants, droppedGlobalGrants, retained, failed };
}

type EntryMerger = (source: string, target: string, state: MergeState, parseGrant: GrantParser) => void;

const ENTRY_MERGERS: Readonly<Record<string, EntryMerger>> = {
  runs: eachEntry(moveIfAbsent, () => true),
  'session-stops': eachEntry(moveIfAbsent, name => name.endsWith('.json')),
  'session-mcp': eachEntry(moveIfAbsent, name => name.endsWith('.json')),
  'session-settings': eachEntry(mergeSettings, name => name.endsWith('.json')),
  'session-orders': eachEntry(mergeOrder, name => name.endsWith('.json')),
  'pending-inputs': eachEntry(mergePendingInputs, name => name.endsWith('.json')),
  'permission-grants.json': (source, target, state, parseGrant) =>
    attempt(state, 'permission-grants.json', () => mergeGrants(source, target, state, parseGrant)),
};

type ItemMerger = (source: string, target: string, item: string, state: MergeState) => void;

function eachEntry(merge: ItemMerger, include: (name: string) => boolean): EntryMerger {
  return (sourceDir, targetDir, state) => {
    if (!fs.statSync(sourceDir).isDirectory()) return;
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of fs.readdirSync(sourceDir).filter(include).sort()) {
      const item = `${path.basename(sourceDir)}/${name}`;
      attempt(state, item, () => merge(path.join(sourceDir, name), path.join(targetDir, name), item, state));
    }
  };
}

function moveIfAbsent(source: string, target: string, item: string, state: MergeState): void {
  if (fs.existsSync(target)) {
    state.conflicts.push(`${item}: kept the canonical copy`);
    return;
  }
  fs.renameSync(source, target);
  state.moved += 1;
  if (item.startsWith('runs/')) state.runsMoved = true;
}

/**
 * Revisions are per-store counters and not comparable, so the newer write wins. A copied file keeps
 * its source mtime, so a later legacy profile is still compared with the original write time.
 */
function mergeSettings(source: string, target: string, item: string, state: MergeState): void {
  if (!fs.existsSync(target)) return moveIfAbsent(source, target, item, state);
  const legacy = settingsRevision(source);
  const canonical = settingsRevision(target);
  const written = fs.statSync(source);
  if (written.mtimeMs > fs.statSync(target).mtimeMs) {
    writeJson(target, readJson(source));
    fs.utimesSync(target, written.atime, written.mtime);
    state.moved += 1;
    state.conflicts.push(`${item}: kept the newer legacy revision ${legacy} over canonical revision ${canonical}`);
  } else {
    state.conflicts.push(`${item}: kept the newer canonical revision ${canonical} over legacy revision ${legacy}`);
  }
}

function settingsRevision(file: string): number {
  const value = readJson(file);
  return isRecord(value) && Number.isSafeInteger(value.revision) && isRecord(value.value) ? value.revision as number : 0;
}

/**
 * The order counter must stay monotonic. Without a counter the Host rescans Runs, so an unreadable
 * legacy counter drops the canonical one: the moved legacy Runs may carry larger orders.
 */
function mergeOrder(source: string, target: string, item: string, state: MergeState): void {
  if (!fs.existsSync(target)) return moveIfAbsent(source, target, item, state);
  const legacy = readOrder(source);
  if (legacy === undefined) {
    fs.rmSync(target, { force: true });
    state.conflicts.push(`${item}: legacy counter unreadable; the next order is rebuilt from the merged Runs`);
    return;
  }
  const canonical = readOrder(target);
  if (canonical !== undefined && legacy > canonical) {
    writeJson(target, legacy);
    state.moved += 1;
  }
}

function readOrder(file: string): number | undefined {
  try {
    const value = readJson(file);
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    // An unreadable counter is the same as a missing one: nextSessionOrder rescans Runs.
    return undefined;
  }
}

interface InputQueue { readonly pending: readonly Record<string, unknown>[]; readonly withdrawn: readonly Record<string, unknown>[] }

/**
 * The result must pass Host recovery: one state per input id (canonical wins) and at most
 * MAX_QUEUED_INPUTS pending. Legacy overflow becomes a withdrawn receipt that clients can see.
 */
function mergePendingInputs(source: string, target: string, item: string, state: MergeState): void {
  if (!fs.existsSync(target)) return moveIfAbsent(source, target, item, state);
  const legacy = readInputQueue(source);
  const canonical = readInputQueue(target);
  const known = new Set([...canonical.pending, ...canonical.withdrawn].map(inputId));
  const added = legacy.pending.filter(entry => !known.has(inputId(entry)));
  const kept = added.slice(0, Math.max(0, MAX_QUEUED_INPUTS - canonical.pending.length));
  const overflow = added.slice(kept.length);
  const pending = [...canonical.pending, ...kept];
  const withdrawn = [...canonical.withdrawn, ...legacy.withdrawn.filter(entry => !known.has(inputId(entry))),
    ...overflow.map(entry => ({ input: entry.input, ...(entry.principalId === undefined ? {} : { principalId: entry.principalId }) }))];
  if (overflow.length > 0) {
    state.conflicts.push(`${item}: withdrew ${overflow.map(inputId).join(', ')} over the ${MAX_QUEUED_INPUTS}-input queue limit`);
  }
  if (pending.length === canonical.pending.length && withdrawn.length === canonical.withdrawn.length) return;
  // Same shape the Host writes: the plain array unless version 2 fields are needed.
  writeJson(target, withdrawn.length === 0 && pending.every(entry => entry.requiredWorkMode === undefined)
    ? pending : { version: 2, pending, withdrawn });
  state.moved += 1;
}

function readInputQueue(file: string): InputQueue {
  const value = readJson(file);
  const queue = Array.isArray(value) ? { pending: value, withdrawn: [] }
    : isRecord(value) && value.version === 2 ? { pending: value.pending, withdrawn: value.withdrawn } : undefined;
  if (!queue || !Array.isArray(queue.pending) || !Array.isArray(queue.withdrawn)
    || ![...queue.pending, ...queue.withdrawn].every(entry => inputId(entry) !== undefined)) {
    throw new Error('Malformed pending Session input queue.');
  }
  return queue as InputQueue;
}

function inputId(entry: unknown): string | undefined {
  return isRecord(entry) && isRecord(entry.input) && typeof entry.input.inputId === 'string' ? entry.input.inputId : undefined;
}

function mergeGrants(source: string, target: string, state: MergeState, parseGrant: GrantParser): void {
  const legacy = readGrantStore(source, parseGrant);
  const canonical = fs.existsSync(target) ? readGrantStore(target, parseGrant) : { revision: 0, value: [] };
  const known = new Set(canonical.value.map(grant => parseGrant(grant).id));
  const scoped = legacy.value.filter(grant => parseGrant(grant).scope.sessionId !== undefined);
  const imported = scoped.filter(grant => !known.has(parseGrant(grant).id));
  state.droppedGlobalGrants += legacy.value.length - scoped.length;
  if (imported.length === 0) return;
  writeJson(target, { revision: canonical.revision + 1, value: [...canonical.value, ...imported] });
  state.importedGrants += imported.length;
}

function readGrantStore(file: string, parseGrant: GrantParser): { readonly revision: number; readonly value: readonly unknown[] } {
  const value = readJson(file);
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || !Array.isArray(value.value)) {
    throw new Error('invalid permission grant store shape');
  }
  value.value.forEach(parseGrant);
  return { revision: value.revision as number, value: value.value };
}

function retire(source: string, profile: string, now: Date, state: MergeState): string | undefined {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  let name = `${profile}.merged-${date}`;
  for (let index = 2; fs.existsSync(path.join(path.dirname(source), name)); index += 1) {
    name = `${profile}.merged-${date}-${index}`;
  }
  const retired = path.join(path.dirname(source), name);
  return attempt(state, '.', () => {
    fs.renameSync(source, retired);
    // Retention counts thirty days from the merge, not from the last legacy write.
    fs.utimesSync(retired, now, now);
    return name;
  });
}

function attempt<T>(state: MergeState, item: string, operation: () => T): T | undefined {
  try {
    return operation();
  } catch (error: unknown) {
    state.failed.push({ item, error: errorMessage(error) });
    return undefined;
  }
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error: unknown) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
