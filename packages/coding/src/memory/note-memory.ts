/**
 * FEATURE_306 — wiring for the note store: the env switch, the system-prompt
 * section (rules + the two MEMORY.md indexes) and the host binding behind the
 * `memory` tool. The old Memory Control Plane is untouched while the switch is off.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  applyMemoryOperation,
  convertLegacyOnce,
  createNoteStore,
  emitKodaXDiagnostic,
  INDEX_FILE,
  resolveMemoryRoot,
  resolveNoteRoot,
  type MemoryOpInput,
  type MemoryOpResult,
  type NoteScope,
} from '@kodax-ai/agent';

import { staticText } from '../prompts/static-text.js';

export const NOTE_MEMORY_ENV = 'KODAX_MEMORY_NOTES';

/** On by default; `KODAX_MEMORY_NOTES=0` falls back to the legacy memory, which stays until it is removed. */
export function isNoteMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[NOTE_MEMORY_ENV] !== '0';
}

function readIndex(root: string): string {
  try {
    return fs.readFileSync(path.join(root, INDEX_FILE), 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    return `(index unreadable: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`;
  }
}

function renderScope(label: string, root: string): string {
  const index = readIndex(root);
  return `## ${label} notes\nDirectory: ${root}\n${index.length > 0 ? index : '(no notes yet)'}`;
}

/**
 * First use of the note memory in a project: copy that project's legacy memories
 * in (see `convertLegacyOnce`). A failure is reported and never blocks the run.
 */
export async function convertLegacyProjectMemory(cwd: string): Promise<void> {
  try {
    await convertLegacyOnce(resolveMemoryRoot(cwd), createNoteStore(resolveNoteRoot(cwd, 'project'), 'project'));
  } catch (error) {
    emitKodaXDiagnostic({
      source: 'coding:note-memory',
      level: 'warn',
      message: `Could not convert the legacy memories of this project: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** Synchronous, side-effect-free, byte-stable while the notes are unchanged. */
export function renderNoteMemorySection(cwd: string): string {
  return [
    staticText('t13.prompts/note-memory-rules.0'),
    '',
    renderScope('Project', resolveNoteRoot(cwd, 'project')),
    '',
    renderScope('User', resolveNoteRoot(cwd, 'user')),
  ].join('\n');
}

/** Bind the `memory` tool to the stores for `cwd`; `getUserText` supplies the CURRENT user message. */
export function createNoteMemoryBinding(
  cwd: string,
  getUserText: () => string,
  sessionId?: string,
): (input: MemoryOpInput) => Promise<MemoryOpResult> {
  const stores = {
    project: createNoteStore(resolveNoteRoot(cwd, 'project'), 'project' satisfies NoteScope),
    user: createNoteStore(resolveNoteRoot(cwd, 'user'), 'user' satisfies NoteScope),
  };
  return (input) => applyMemoryOperation({ stores, userMessage: getUserText(), ...(sessionId === undefined ? {} : { sessionId }) }, input);
}
