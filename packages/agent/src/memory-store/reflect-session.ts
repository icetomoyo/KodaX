/**
 * FEATURE_308 — one pass of the reflection job over one session: gate, evidence,
 * judge, host-validated apply, cursor. The judge is injected, so this file holds
 * no model client and the whole job runs against a stub in tests.
 *
 * The cursor is written only after the judge answered, so a failed run is
 * retried; a thrown judge error reaches the caller instead of being swallowed.
 * A session that keeps going is read again once it has grown by a few user turns,
 * and every judge call spends one of the day's slots (the cost cap).
 */
import type { KodaXMessage } from '@kodax-ai/llm';

import { buildEvidence, collectSegments, type SessionEvidence } from './evidence.js';
import { takeReflectionSlot } from './reflection-budget.js';
import { markReflected, reflectedUserTurns } from './reflection-cursor.js';
import { shouldReflect, signalsOf } from './reflection-gate.js';
import { applyReflectionOperation, type ReflectionOpInput, type SkillSink } from './reflection-op.js';
import type { MemoryNote, NoteScope } from './record.js';
import type { NoteStore } from './store.js';

/** A session already reflected is read again only after this many more user turns. */
export const REFLECT_AGAIN_AFTER_TURNS = 3;

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
  /** Judge calls allowed per day; defaults to the job's standing cap. */
  readonly dailyCap?: number;
  /** Where a validated skill proposal goes; without it every proposal is refused. */
  readonly skills?: SkillSink;
}

export type ReflectSessionResult =
  | { readonly status: 'skipped'; readonly reason: 'already-reflected' | 'no-signal' | 'daily-cap' }
  | {
      readonly status: 'done';
      readonly applied: number;
      /** Applied operations by kind, for the local counters. */
      readonly appliedByOperation: Readonly<Partial<Record<ReflectionOpInput['operation'], number>>>;
      readonly rejected: readonly string[];
    };

/** Archived notes are out of play: the judge neither sees nor edits them. */
async function currentNotes(stores: Readonly<Record<NoteScope, NoteStore>>): Promise<MemoryNote[]> {
  const all = [...await stores.project.list(), ...await stores.user.list()];
  return all.filter((note) => note.status !== 'archived');
}

export async function reflectSession(input: ReflectSessionInput): Promise<ReflectSessionResult> {
  const userTurns = signalsOf(collectSegments(input.messages)).userTurns;
  const before = await reflectedUserTurns(input.cursorRoot, input.sessionId);
  if (before !== undefined && userTurns < before + REFLECT_AGAIN_AFTER_TURNS) return { status: 'skipped', reason: 'already-reflected' };
  if (!shouldReflect(input.messages)) return { status: 'skipped', reason: 'no-signal' };
  if (!await takeReflectionSlot(input.cursorRoot, input.now?.(), input.dailyCap)) return { status: 'skipped', reason: 'daily-cap' };

  const evidence = buildEvidence(input.messages);
  const operations = await input.judge({ evidence, notes: await currentNotes(input.stores) });
  let applied = 0;
  const appliedByOperation: Partial<Record<ReflectionOpInput['operation'], number>> = {};
  const rejected: string[] = [];
  const context = { stores: input.stores, evidence, sessionId: input.sessionId, ...(input.now === undefined ? {} : { now: input.now }), ...(input.skills === undefined ? {} : { skills: input.skills }) };
  for (const operation of operations) {
    // One failing write must not lose the rest, nor the cursor: the judge call is already paid for.
    const outcome = await applyReflectionOperation(context, operation).catch((error: unknown) => ({
      ok: false,
      message: `failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
    if (outcome.ok) {
      applied += 1;
      appliedByOperation[operation.operation] = (appliedByOperation[operation.operation] ?? 0) + 1;
    } else rejected.push(`${operation.operation} ${operation.id}: ${outcome.message}`);
  }
  await markReflected(input.cursorRoot, input.sessionId, (input.now?.() ?? new Date()).getTime(), userTurns);
  return { status: 'done', applied, appliedByOperation, rejected };
}
