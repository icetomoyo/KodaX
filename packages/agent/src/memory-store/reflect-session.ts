/**
 * FEATURE_306 — one pass of the reflection job over one session: gate, evidence,
 * judge, host-validated apply, cursor. The judge is injected, so this file holds
 * no model client and the whole job runs against a stub in tests.
 *
 * The cursor is written only after the judge answered, so a failed run is
 * retried; a thrown judge error reaches the caller instead of being swallowed.
 */
import type { KodaXMessage } from '@kodax-ai/llm';

import { buildEvidence, type SessionEvidence } from './evidence.js';
import { isReflected, markReflected } from './reflection-cursor.js';
import { shouldReflect } from './reflection-gate.js';
import { applyReflectionOperation, type ReflectionOpInput } from './reflection-op.js';
import type { MemoryNote, NoteScope } from './record.js';
import type { NoteStore } from './store.js';

export type ReflectionJudge = (request: {
  readonly evidence: SessionEvidence;
  readonly notes: readonly MemoryNote[];
}) => Promise<readonly ReflectionOpInput[]>;

export interface ReflectSessionInput {
  readonly sessionId: string;
  readonly messages: readonly KodaXMessage[];
  readonly stores: Readonly<Record<NoteScope, NoteStore>>;
  /** Directory holding the cursor file. */
  readonly cursorRoot: string;
  readonly judge: ReflectionJudge;
  readonly now?: () => Date;
}

export type ReflectSessionResult =
  | { readonly status: 'skipped'; readonly reason: 'already-reflected' | 'no-signal' }
  | { readonly status: 'done'; readonly applied: number; readonly rejected: readonly string[] };

/** Archived notes are out of play: the judge neither sees nor edits them. */
async function currentNotes(stores: Readonly<Record<NoteScope, NoteStore>>): Promise<MemoryNote[]> {
  const all = [...await stores.project.list(), ...await stores.user.list()];
  return all.filter((note) => note.status !== 'archived');
}

export async function reflectSession(input: ReflectSessionInput): Promise<ReflectSessionResult> {
  if (await isReflected(input.cursorRoot, input.sessionId)) return { status: 'skipped', reason: 'already-reflected' };
  if (!shouldReflect(input.messages)) return { status: 'skipped', reason: 'no-signal' };

  const evidence = buildEvidence(input.messages);
  const operations = await input.judge({ evidence, notes: await currentNotes(input.stores) });
  let applied = 0;
  const rejected: string[] = [];
  for (const operation of operations) {
    const outcome = await applyReflectionOperation(
      { stores: input.stores, evidence, sessionId: input.sessionId, ...(input.now === undefined ? {} : { now: input.now }) },
      operation,
    );
    if (outcome.ok) applied += 1;
    else rejected.push(`${operation.operation} ${operation.id}: ${outcome.message}`);
  }
  await markReflected(input.cursorRoot, input.sessionId, (input.now?.() ?? new Date()).getTime());
  return { status: 'done', applied, rejected };
}
