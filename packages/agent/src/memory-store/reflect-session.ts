/**
 * FEATURE_308 — one pass of the reflection job over one session: gate, evidence,
 * judge, host-validated apply, cursor. The judge is injected, so this file holds
 * no model client and the whole job runs against a stub in tests.
 *
 * The evidence is saved as pending before the judge call and the cursor is
 * written only after the judge answered, so a failed run is retried; a thrown
 * judge error reaches the caller instead of being swallowed. A session that keeps
 * going is read again once it has grown by a few user turns; the turns in between
 * stay pending, for its next pass or for `drainPendingReflections` once it has
 * gone quiet. Every judge call spends one of the day's slots (the cost cap).
 */
import type { KodaXMessage } from '@kodax-ai/llm';

import { buildEvidence, collectSegments, type SessionEvidence } from './evidence.js';
import { takeReflectionSlot } from './reflection-budget.js';
import { markReflected, reflectedUserTurns } from './reflection-cursor.js';
import { freezePending, listPending, livePending, PENDING_IDLE_MS, removePending, savePending, type PendingReflection } from './reflection-pending.js';
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
  /** Opaque id of the session's project, recorded on user-scope notes. */
  readonly project?: string;
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
  const root = input.cursorRoot;
  const now = input.now?.() ?? new Date();
  const userTurns = signalsOf(collectSegments(input.messages)).userTurns;
  let before = await reflectedUserTurns(root, input.sessionId);
  const live = await livePending(root, input.sessionId);
  // Compaction (or a rewind) dropped turns: the count starts over, and the turns it dropped stay pending.
  if (userTurns < (live?.userTurns ?? before ?? 0)) {
    await freezePending(root, input.sessionId);
    await markReflected(root, input.sessionId, now.getTime(), 0);
    before = 0;
  }
  if (!shouldReflect(input.messages)) return { status: 'skipped', reason: 'no-signal' };
  if (before !== undefined && userTurns <= before) return { status: 'skipped', reason: 'already-reflected' };
  // Saved before the judge call, so an exit, a crash or a failed call leaves it for a later pass.
  const record: PendingReflection = { sessionId: input.sessionId, ...projectOf(input), at: now.getTime(), userTurns, evidence: buildEvidence(input.messages) };
  await savePending(root, record);
  if (before !== undefined && userTurns < before + REFLECT_AGAIN_AFTER_TURNS) return { status: 'skipped', reason: 'already-reflected' };
  return reflectPending(input, record);
}

/**
 * Reflects what other sessions of this project left pending: turns that compaction
 * dropped, and sessions that went quiet before their next pass was due, ended or
 * crashed. A live session is left to itself until it has been quiet for a while.
 */
export async function drainPendingReflections(input: Omit<ReflectSessionInput, 'messages'>): Promise<ReflectSessionResult[]> {
  const now = (input.now?.() ?? new Date()).getTime();
  const due = (await listPending(input.cursorRoot, now)).filter((record) =>
    record.project === input.project
    && (record.frozen === true || (record.sessionId !== input.sessionId && now - record.at >= PENDING_IDLE_MS)));
  const results: ReflectSessionResult[] = [];
  for (const record of due) {
    const result = await reflectPending(input, record);
    results.push(result);
    if (result.status !== 'done') break;
  }
  return results;
}

const projectOf = (input: { readonly project?: string }) => (input.project === undefined ? {} : { project: input.project });

async function reflectPending(input: Omit<ReflectSessionInput, 'messages'>, record: PendingReflection): Promise<ReflectSessionResult> {
  if (!await takeReflectionSlot(input.cursorRoot, input.now?.(), input.dailyCap)) return { status: 'skipped', reason: 'daily-cap' };
  const { evidence, sessionId } = record;
  const operations = await input.judge({ evidence, notes: await currentNotes(input.stores) });
  let applied = 0;
  const appliedByOperation: Partial<Record<ReflectionOpInput['operation'], number>> = {};
  const rejected: string[] = [];
  const context = { stores: input.stores, evidence, sessionId, ...projectOf(record), ...(input.now === undefined ? {} : { now: input.now }), ...(input.skills === undefined ? {} : { skills: input.skills }) };
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
  if (record.frozen !== true) await markReflected(input.cursorRoot, sessionId, (input.now?.() ?? new Date()).getTime(), record.userTurns);
  await removePending(input.cursorRoot, record);
  return { status: 'done', applied, appliedByOperation, rejected };
}
