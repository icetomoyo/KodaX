/**
 * FEATURE_306 — the operations the background reflection worker may apply.
 * Authority comes from the evidence the HOST collected, never from what the
 * model claims about it (see evidence.ts):
 *   write        quote found in a user message -> active; no quote -> candidate
 *   corroborate  candidate -> active; needs proof from user or local output, and a
 *                session other than the one that proposed it (or the user's own words)
 *   dispute      active or candidate -> disputed (hidden from the index, kept on disk)
 *   rewrite      corrects a note; a note the user stated can only be rewritten
 *                from a user message, local evidence can only dispute it
 * External content (web, MCP) is never accepted as proof.
 */
import { quoteInEvidence, type SessionEvidence } from './evidence.js';
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
  readonly now?: () => Date;
}

const NEEDS_PROOF = 'quote must be exact words from a user message or a local tool result in this session. Web and MCP content is not accepted as proof.';

function fail(message: string): MemoryOpResult {
  return { ok: false, message };
}

export async function applyReflectionOperation(context: ReflectionOpContext, input: ReflectionOpInput): Promise<MemoryOpResult> {
  if (input.operation === 'write') {
    return applyMemoryOperation(
      { stores: context.stores, userMessage: context.evidence.userText, sessionId: context.sessionId },
      {
        operation: 'write',
        id: input.id,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.why === undefined ? {} : { why: input.why }),
        ...(input.check === undefined ? {} : { check: input.check }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.quote === undefined ? {} : { userQuote: input.quote }),
      },
    );
  }
  const store = context.stores[input.scope ?? 'project'];
  const note = (await store.list()).find((item) => item.id === input.id);
  if (note === undefined) return fail(`No memory with id '${input.id}'.`);
  const fromUser = input.quote !== undefined && quoteInEvidence(context.evidence, input.quote, ['user']);
  const proven = fromUser || (input.quote !== undefined && quoteInEvidence(context.evidence, input.quote, ['local']));
  if (!proven) return fail(NEEDS_PROOF);
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

async function rewrite(store: NoteStore, note: MemoryNote, input: ReflectionOpInput, fromUser: boolean): Promise<MemoryOpResult> {
  if (note.status === 'archived') return fail(`Memory '${note.id}' is archived.`);
  if (note.source !== 'inferred' && !fromUser) {
    return fail('A note the user stated can only be rewritten from the user\'s own words. Dispute it instead.');
  }
  const done = await store.edit(note.id, {
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.check === undefined ? {} : { check: input.check }),
    ...(input.why === undefined ? {} : { why: input.why }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(note.status === 'disputed' ? { status: 'active' as const } : {}),
  });
  return done.ok ? { ok: true, message: `Rewrote memory '${note.id}'.` } : fail(done.reason === 'secret' ? (done.detail ?? 'Secrets are never stored in memory.') : `Could not update '${note.id}'.`);
}
