/**
 * FEATURE_306 — usage signals. A note counts as used when the agent opened its
 * file with the `read` tool and the read succeeded. The host observes this in
 * the transcript; the model never reports it. Nothing else counts: an index
 * line the model merely saw is not a read, so a note is never judged unused
 * just because its one-line description was enough.
 */
import * as path from 'node:path';

import type { KodaXMessage } from '@kodax-ai/llm';

import { INDEX_FILE } from './store.js';
import type { NoteScope } from './record.js';
import type { NoteStore } from './store.js';

export type NoteReads = Readonly<Record<NoteScope, Readonly<Record<string, number>>>>;

function readPath(input: Record<string, unknown>): string | undefined {
  const value = input.path ?? input.file_path;
  return typeof value === 'string' ? value : undefined;
}

/** `<root>/<id>.md` directly under the root, never the index or a nested file. */
function noteIdAt(root: string, file: string): string | undefined {
  const relative = path.relative(root, path.resolve(file));
  if (relative.length === 0 || relative.includes(path.sep) || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  if (!relative.endsWith('.md') || relative.toUpperCase() === INDEX_FILE.toUpperCase()) return undefined;
  return relative.slice(0, -3);
}

/** Ids of every tool call already in `messages`, so a later run can tell its own reads from the history it resumed. */
export function toolUseIds(messages: readonly KodaXMessage[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) if (block.type === 'tool_use') ids.add(block.id);
  }
  return ids;
}

export function noteReadsFrom(
  messages: readonly KodaXMessage[],
  roots: Readonly<Record<NoteScope, string>>,
  ignoreCalls: ReadonlySet<string> = new Set(),
): NoteReads {
  const pending = new Map<string, string>();
  const counts: Record<NoteScope, Record<string, number>> = { project: {}, user: {} };
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.name === 'read' && !ignoreCalls.has(block.id)) {
        const file = readPath(block.input);
        if (file !== undefined) pending.set(block.id, file);
      } else if (block.type === 'tool_result' && block.is_error !== true) {
        const file = pending.get(block.tool_use_id);
        if (file === undefined) continue;
        for (const scope of ['project', 'user'] as const) {
          const id = noteIdAt(roots[scope], file);
          if (id !== undefined) counts[scope][id] = (counts[scope][id] ?? 0) + 1;
        }
      }
    }
  }
  return counts;
}

export interface RecordReadsInput {
  readonly stores: Readonly<Record<NoteScope, NoteStore>>;
  readonly messages: readonly KodaXMessage[];
  /** Tool calls from earlier runs of the same session, which were counted then. */
  readonly ignoreCalls?: ReadonlySet<string>;
  readonly now?: () => Date;
}

/** Adds the reads found in `messages` to the notes' usage counters; returns how many notes were updated. */
export async function recordNoteReads(input: RecordReadsInput): Promise<number> {
  const reads = noteReadsFrom(input.messages, { project: input.stores.project.root, user: input.stores.user.root }, input.ignoreCalls);
  const at = input.now?.() ?? new Date();
  let updated = 0;
  for (const scope of ['project', 'user'] as const) {
    if (Object.keys(reads[scope]).length > 0) updated += await input.stores[scope].recordUse(reads[scope], at);
  }
  return updated;
}
