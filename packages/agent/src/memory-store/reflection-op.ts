/**
 * FEATURE_308 — the operations the background reflection worker may apply.
 * Authority comes from the evidence the HOST collected, never from what the
 * model claims about it (see evidence.ts):
 *   write        quote found in a user message -> active; no quote, or one from
 *                local output -> candidate
 *   corroborate  candidate -> active; needs proof from user or local output, and a
 *                session other than the one that proposed it (or the user's own words)
 *   dispute      active or candidate -> disputed (hidden from the index, kept on disk)
 *   rewrite      corrects a note; a note the user stated can only be rewritten
 *                from a user message, local evidence can only dispute it; a
 *                candidate or disputed note rewritten from a user message becomes
 *                active, a disputed one rewritten from local output a candidate;
 *                a body longer than the job was shown keeps its body
 * External content (web, MCP) is never accepted as proof. A user-scope note
 * reaches every project, so only a user message can change it; a user-scope
 * candidate can also be confirmed by local output from a different project.
 */
import { copiesExternalText, quoteInEvidence, type SessionEvidence } from './evidence.js';
import { applyMemoryOperation, type MemoryOpResult } from './memory-op.js';
import type { MemoryNote, NoteScope, NoteType } from './record.js';
import type { NoteStore } from './store.js';

export interface ReflectionOpInput {
  readonly operation: 'write' | 'corroborate' | 'dispute' | 'rewrite';
  readonly id: string;
  readonly scope?: NoteScope;
  readonly type?: NoteType;
  readonly description?: string;
  readonly why?: string;
  readonly check?: string;
  readonly body?: string;
  /** Exact words from a user message or a local tool result in the evidence. */
  readonly quote?: string;
}

export interface ReflectionOpContext {
  readonly stores: Readonly<Record<NoteScope, NoteStore>>;
  readonly evidence: SessionEvidence;
  readonly sessionId: string;
  /** Opaque id of the session's project; lets a different project confirm a user-scope candidate. */
  readonly project?: string;
  readonly now?: () => Date;
}

const NEEDS_PROOF = 'quote must be exact words from a user message or a local tool result in this session. Web and MCP content is not accepted as proof.';

const NEEDS_USER_WORDS = 'quote must be a full statement from a user message. Leave it out, with a why, to propose a candidate instead.';

const USER_SCOPE_NEEDS_USER = 'A user-scope note applies to every project, so only the user\'s own words can change it.';

const USER_SCOPE_NEEDS_OTHER_PROJECT = 'A user-scope candidate applies to every project, so it is confirmed only by the user\'s own words or by local output from a project other than the one that proposed it.';

function fromOtherProject(note: MemoryNote, context: ReflectionOpContext): boolean {
  return note.project !== undefined && context.project !== undefined && note.project !== context.project;
}

const COPIES_EXTERNAL = 'The note repeats text from external content (web or MCP). State what you learned in your own words, or leave it out.';

function fail(message: string): MemoryOpResult {
  return { ok: false, message };
}

export async function applyReflectionOperation(context: ReflectionOpContext, input: ReflectionOpInput): Promise<MemoryOpResult> {
  const written = [input.description, input.why, input.check, input.body].filter((text): text is string => text !== undefined);
  if (input.operation !== 'corroborate' && written.some((text) => copiesExternalText(context.evidence, text))) {
    return fail(COPIES_EXTERNAL);
  }
  if (input.operation === 'write') {
    // A question states no decision, so quoting one cannot make a note the user's own.
    const statedQuote = input.quote !== undefined && !/[?？]\s*$/.test(input.quote) ? input.quote : undefined;
    const userQuote = statedQuote !== undefined && quoteInEvidence(context.evidence, statedQuote, ['user']) ? statedQuote : undefined;
    // The job answers once and never sees this result, so a lesson quoted from local output
    // is kept as a candidate instead of lost. Only the user's words make a note active.
    const localQuote = statedQuote !== undefined && userQuote === undefined && quoteInEvidence(context.evidence, statedQuote, ['local']) ? statedQuote : undefined;
    if (statedQuote !== undefined && userQuote === undefined && localQuote === undefined) return fail(NEEDS_USER_WORDS);
    const why = input.why !== undefined && input.why.trim().length > 0 ? input.why : localQuote === undefined ? input.why : `local output: "${localQuote}"`;
    return applyMemoryOperation(
      {
        stores: context.stores,
        userMessage: context.evidence.userText,
        sessionId: context.sessionId,
        ...(context.project === undefined ? {} : { project: context.project }),
      },
      {
        operation: 'write',
        id: input.id,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(why === undefined ? {} : { why }),
        ...(input.check === undefined ? {} : { check: input.check }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(userQuote === undefined ? {} : { userQuote }),
      },
    );
  }
  const found = await findNote(context, input);
  if (found === undefined) return fail(`No memory with id '${input.id}'.`);
  const { store, note } = found;
  const fromUser = input.quote !== undefined && quoteInEvidence(context.evidence, input.quote, ['user']);
  const proven = fromUser || (input.quote !== undefined && quoteInEvidence(context.evidence, input.quote, ['local']));
  if (!proven) return fail(NEEDS_PROOF);
  // A file in a cloned repository is local output too, and it must not steer every other project.
  // Two projects showing the same thing is independent evidence, so that alone may confirm a candidate.
  if (note.scope === 'user' && !fromUser && !(input.operation === 'corroborate' && fromOtherProject(note, context))) {
    return fail(input.operation === 'corroborate' ? USER_SCOPE_NEEDS_OTHER_PROJECT : USER_SCOPE_NEEDS_USER);
  }
  switch (input.operation) {
    case 'corroborate':
      return corroborate(store, context, note, fromUser);
    case 'dispute':
      return dispute(store, context, note, input);
    case 'rewrite':
      return rewrite(store, note, input, fromUser);
    default:
      return fail('operation must be "write", "corroborate", "dispute" or "rewrite".');
  }
}

/**
 * The note in the named scope. A call that names no scope also reaches a user-scope note,
 * because the job sees every note's scope but often leaves it out, and the id names one note.
 */
async function findNote(context: ReflectionOpContext, input: ReflectionOpInput): Promise<{ store: NoteStore; note: MemoryNote } | undefined> {
  const scopes: readonly NoteScope[] = input.scope === undefined ? ['project', 'user'] : [input.scope];
  for (const scope of scopes) {
    const store = context.stores[scope];
    const note = (await store.list()).find((item) => item.id === input.id);
    if (note !== undefined) return { store, note };
  }
  return undefined;
}

async function corroborate(store: NoteStore, context: ReflectionOpContext, note: MemoryNote, fromUser: boolean): Promise<MemoryOpResult> {
  if (note.status !== 'candidate') return fail(`Memory '${note.id}' is ${note.status}, not a candidate.`);
  const independent = note.session !== undefined && note.session !== context.sessionId;
  if (!independent && !fromUser) {
    return fail('A candidate proposed in this session needs evidence from a different session, or the user\'s own words.');
  }
  const done = await store.edit(note.id, { status: 'active', ...(fromUser ? { source: 'user' as const } : {}) });
  return done.ok ? { ok: true, message: `Memory '${note.id}' is now active.` } : fail(`Could not update '${note.id}'.`);
}

async function dispute(store: NoteStore, context: ReflectionOpContext, note: MemoryNote, input: ReflectionOpInput): Promise<MemoryOpResult> {
  if (note.status !== 'active' && note.status !== 'candidate') return fail(`Memory '${note.id}' is ${note.status}.`);
  const stamp = (context.now?.() ?? new Date()).toISOString().slice(0, 10);
  const flat = (text: string | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const reason = flat(input.why);
  const line = `CONFLICT (${stamp}, session ${context.sessionId}): ${reason.length > 0 ? reason : 'later evidence contradicts this note'} Evidence: "${flat(input.quote)}"`;
  const done = await store.edit(note.id, { status: 'disputed', body: `${note.body.trimEnd()}\n\n${line}\n` });
  return done.ok ? { ok: true, message: `Memory '${note.id}' is now disputed.` } : fail(`Could not update '${note.id}'.`);
}

/** How much of a note body the reflection job is shown. */
export const NOTE_VIEW_CHARS = 1500;

/**
 * The body as the reflection job sees it. A long body keeps its head and its end,
 * because dispute appends its CONFLICT lines at the end.
 */
export function noteBodyView(body: string): string {
  const text = body.trim();
  if (text.length <= NOTE_VIEW_CHARS) return text;
  const tail = Math.floor(NOTE_VIEW_CHARS / 3);
  const head = NOTE_VIEW_CHARS - tail;
  return `${text.slice(0, head)}\n[... ${text.length - NOTE_VIEW_CHARS} characters not shown ...]\n${text.slice(-tail)}`;
}

async function rewrite(store: NoteStore, note: MemoryNote, input: ReflectionOpInput, fromUser: boolean): Promise<MemoryOpResult> {
  if (note.status === 'archived') return fail(`Memory '${note.id}' is archived.`);
  if (input.description === undefined || input.description.trim().length === 0) {
    return fail('A rewrite needs the new description: it is the line the index shows, so it must say the corrected thing.');
  }
  if (note.source !== 'inferred' && !fromUser) {
    return fail('A note the user stated can only be rewritten from the user\'s own words. Dispute it instead.');
  }
  // The job saw only part of this body, so a new body would drop the part it never saw.
  if (input.body !== undefined && note.body.trim().length > NOTE_VIEW_CHARS) {
    return fail(`The body of '${note.id}' is longer than the part shown, so it cannot be replaced; change its description, why or check instead.`);
  }
  const done = await store.edit(note.id, {
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.check === undefined ? {} : { check: input.check }),
    ...(input.why === undefined ? {} : { why: input.why }),
    ...(input.body === undefined ? {} : { body: input.body }),
    // A correction the user stated settles the note and makes it theirs, as with corroborate.
    // One from local output is this session's reading, so the note waits for confirmation.
    ...(note.status === 'disputed' && !fromUser ? { status: 'candidate' as const } : {}),
    ...((note.status === 'candidate' || note.status === 'disputed') && fromUser ? { status: 'active' as const, source: 'user' as const } : {}),
  });
  return done.ok ? { ok: true, message: `Rewrote memory '${note.id}'.` } : fail(done.reason === 'secret' ? (done.detail ?? 'Secrets are never stored in memory.') : `Could not update '${note.id}'.`);
}
