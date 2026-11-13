/**
 * FEATURE_306 — wiring for the note store: the env switch, where a run's notes
 * live, the system-prompt section (rules + the two MEMORY.md indexes) and the
 * host binding behind the `memory` tool. The old Memory Control Plane is
 * untouched while the switch is off.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  applyMemoryOperation,
  convertLegacyOnce,
  createNoteStore,
  emitKodaXDiagnostic,
  getAgentConfigPath,
  INDEX_FILE,
  LEGACY_CONVERTED_MARKER,
  resolveMemoryRoot,
  resolveNoteRoot,
  resolveScopedMemoryRoot,
  type DurableMemoryScope,
  type MemoryContextIdentity,
  type MemoryOpInput,
  type MemoryOpResult,
  type NoteScope,
  type NoteStore,
} from '@kodax-ai/agent';

import { resolveExecutionCwd } from '../runtime-paths.js';
import { deriveCodingMemoryIdentity } from '../memory-runtime.js';
import { staticText } from '../prompts/static-text.js';
import type { KodaXOptions } from '../types.js';

export const NOTE_MEMORY_ENV = 'KODAX_MEMORY_NOTES';

/** On by default; `KODAX_MEMORY_NOTES=0` falls back to the legacy memory, which stays until it is removed. */
export function isNoteMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[NOTE_MEMORY_ENV] !== '0';
}

/**
 * The note memory belongs to the top-level run: it reads the index, holds the
 * `memory` tool and gets the follow-up. A child agent's notes would duplicate
 * its parent's, and its messages are the parent's work anyway.
 */
export function noteMemoryAppliesTo(options: KodaXOptions): boolean {
  return isNoteMemoryEnabled()
    && options.context?.currentAgentId === undefined
    && options.context?.parentAgentId === undefined;
}

interface LegacySource {
  readonly root: string;
  readonly scope: NoteScope;
  readonly marker: string;
}

/** Where one run's notes live, and the legacy memory directories that feed them. */
export interface NotePlace {
  readonly cwd: string;
  readonly roots: Readonly<Record<NoteScope, string>>;
  /** The identity the legacy memory used; learned skills are saved under it too. */
  readonly identity: MemoryContextIdentity & { readonly configHome: string };
  readonly legacy: readonly LegacySource[];
}

/** Legacy scopes that still exist on disk, and the note scope each one feeds. */
const LEGACY_SCOPES: readonly { readonly scope: DurableMemoryScope; readonly into: NoteScope; readonly needs?: keyof MemoryContextIdentity }[] = [
  { scope: 'project', into: 'project', needs: 'projectId' },
  { scope: 'workspace', into: 'project', needs: 'workspaceId' },
  { scope: 'agent', into: 'user' },
  { scope: 'user', into: 'user', needs: 'userId' },
];

function scopedNoteRoot(identity: MemoryContextIdentity, order: readonly DurableMemoryScope[], into: NoteScope): string {
  const fields: Record<DurableMemoryScope, keyof MemoryContextIdentity> = { project: 'projectId', workspace: 'workspaceId', user: 'userId', agent: 'agentId' };
  const scope = order.find((item) => identity[fields[item]] !== undefined) ?? 'agent';
  return path.join(resolveScopedMemoryRoot(identity, scope), `${into}-notes`);
}

/**
 * A host that names the memory identity (one tenant per user, as a hosted
 * product does) gets stores inside that identity's own directories, so two
 * tenants never read each other's notes. Without one, notes follow the
 * project's git remote, shared by every worktree and clone.
 */
export function resolveNotePlace(options: KodaXOptions, cwd: string = resolveExecutionCwd(options.context)): NotePlace {
  const hosted = options.context?.memoryIdentity;
  const derived = hosted ?? deriveCodingMemoryIdentity(options, cwd, 'notes');
  const identity = { ...derived, configHome: derived.configHome ?? getAgentConfigPath() };
  const roots = hosted === undefined
    ? { project: resolveNoteRoot(cwd, 'project'), user: resolveNoteRoot(cwd, 'user') }
    : { project: scopedNoteRoot(identity, ['project', 'workspace'], 'project'), user: scopedNoteRoot(identity, ['user'], 'user') };
  const scoped = LEGACY_SCOPES
    .filter((item) => item.needs === undefined || identity[item.needs] !== undefined)
    .map((item) => ({ root: resolveScopedMemoryRoot(identity, item.scope), scope: item.into, marker: `.legacy-${item.scope}-scope-converted.json` }));
  return {
    cwd,
    roots,
    identity,
    legacy: hosted === undefined ? [{ root: resolveMemoryRoot(cwd), scope: 'project', marker: LEGACY_CONVERTED_MARKER }, ...scoped] : scoped,
  };
}

export function noteStoresFor(place: NotePlace): Readonly<Record<NoteScope, NoteStore>> {
  return {
    project: createNoteStore(place.roots.project, 'project'),
    user: createNoteStore(place.roots.user, 'user'),
  };
}

function readIndex(root: string): string {
  try {
    return fs.readFileSync(path.join(root, INDEX_FILE), 'utf8').trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return '';
    emitKodaXDiagnostic({ source: 'coding:note-memory', level: 'warn', message: `Could not read the memory index in ${root}: ${code ?? String(error)}` });
    return `(index unreadable: ${code ?? 'unknown error'})`;
  }
}

function renderScope(label: string, root: string): string {
  const index = readIndex(root);
  return `## ${label} notes\nDirectory: ${root}\n${index.length > 0 ? index : '(no notes yet)'}`;
}

/**
 * First use of the note memory: copy each legacy memory directory in once (see
 * `convertLegacyOnce`). A failure is reported and never blocks the run.
 */
export async function convertLegacyMemory(place: NotePlace): Promise<void> {
  const stores = noteStoresFor(place);
  for (const source of place.legacy) {
    try {
      await convertLegacyOnce(source.root, stores[source.scope], Date.now(), source.marker);
    } catch (error) {
      emitKodaXDiagnostic({
        source: 'coding:note-memory',
        level: 'warn',
        message: `Could not convert the legacy memories in ${source.root}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

/** Synchronous, side-effect-free, byte-stable while the notes are unchanged. */
export function renderNoteMemorySection(place: NotePlace): string {
  return [
    staticText('t13.prompts/note-memory-rules.0'),
    '',
    renderScope('Project', place.roots.project),
    '',
    renderScope('User', place.roots.user),
  ].join('\n');
}

/** Bind the `memory` tool to the run's stores; `getUserText` supplies the CURRENT user message. */
export function createNoteMemoryBinding(
  place: NotePlace,
  getUserText: () => string,
  sessionId?: string,
): (input: MemoryOpInput) => Promise<MemoryOpResult> {
  const stores = noteStoresFor(place);
  return (input) => applyMemoryOperation({ stores, userMessage: getUserText(), ...(sessionId === undefined ? {} : { sessionId }) }, input);
}
