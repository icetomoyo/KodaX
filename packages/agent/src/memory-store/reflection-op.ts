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
 *   skill        proposes a learned skill; same proof as dispute, a valid and
 *                unsafe-pattern-free spec, no external text; the host stores it
 *                as "ready", so the user reviews it before it is ever used
 * External content (web, MCP) is never accepted as proof.
 */
import type { DeclarativeSkillSpec } from '../learning/learned-skill.js';
import { validateDeclarativeSkillSpec } from '../learning/learned-skill.js';
import { copiesExternalText, quoteInEvidence, type SessionEvidence } from './evidence.js';
import { applyMemoryOperation, type MemoryOpResult } from './memory-op.js';
import type { MemoryNote, NoteScope, NoteType } from './record.js';
import type { NoteStore } from './store.js';

export interface ReflectionOpInput {
  readonly operation: 'write' | 'corroborate' | 'dispute' | 'rewrite' | 'skill';
  readonly id: string;
  readonly scope?: NoteScope;
  readonly type?: NoteType;
  readonly description?: string;
  readonly why?: string;
  readonly check?: string;
  readonly body?: string;
  /** Exact words from a user message or a local tool result in the evidence. */
  readonly quote?: string;
  /** The procedure a `skill` operation proposes. */
  readonly skill?: DeclarativeSkillSpec;
}

/** Where a validated skill proposal goes; the host supplies it, so this file knows nothing of the learned area. */
export type SkillSink = (
  spec: DeclarativeSkillSpec,
  origin: { readonly sessionId: string; readonly decisionId: string },
) => Promise<MemoryOpResult>;

export interface ReflectionOpContext {
  readonly stores: Readonly<Record<NoteScope, NoteStore>>;
  readonly evidence: SessionEvidence;
  readonly sessionId: string;
  readonly now?: () => Date;
  readonly skills?: SkillSink;
}

const NEEDS_PROOF = 'quote must be exact words from a user message or a local tool result in this session. Web and MCP content is not accepted as proof.';

const COPIES_EXTERNAL = 'The note repeats text from external content (web or MCP). State what you learned in your own words, or leave it out.';

function fail(message: string): MemoryOpResult {
  return { ok: false, message };
}

async function proposeSkill(context: ReflectionOpContext, input: ReflectionOpInput): Promise<MemoryOpResult> {
  if (context.skills === undefined) return fail('Skill proposals are not available here.');
  const spec = input.skill;
  if (spec === undefined) return fail('A skill proposal needs the skill: name, description, purpose, triggers, steps, verification and pitfalls.');
  if (input.quote === undefined || !quoteInEvidence(context.evidence, input.quote, ['user', 'local'])) return fail(NEEDS_PROOF);
  const texts = [spec.name, spec.description, spec.purpose, ...spec.triggers, ...spec.steps, ...spec.verification, ...spec.pitfalls];
  if (texts.some((text) => copiesExternalText(context.evidence, text))) return fail(COPIES_EXTERNAL);
  try {
    validateDeclarativeSkillSpec(spec);
  } catch {
    return fail('The skill was rejected: it is incomplete, too large, or contains text that is not allowed in a skill.');
  }
  return context.skills(spec, { sessionId: context.sessionId, decisionId: `${context.sessionId}:${spec.name}` });
}

export async function applyReflectionOperation(context: ReflectionOpContext, input: ReflectionOpInput): Promise<MemoryOpResult> {
  if (input.operation === 'skill') return proposeSkill(context, input);
  const written = [input.description, input.why, input.check, input.body].filter((text): text is string => text !== undefined);
  if (input.operation !== 'corroborate' && written.some((text) => copiesExternalText(context.evidence, text))) {
    return fail(COPIES_EXTERNAL);
  }
  if (input.operation === 'write') {
    // A question states no decision, so quoting one cannot make a note the user's own.
    const statedQuote = input.quote !== undefined && !/[?？]\s*$/.test(input.quote) ? input.quote : undefined;
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
        ...(statedQuote === undefined ? {} : { userQuote: statedQuote }),
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
      return fail('operation must be "write", "corroborate", "dispute", "rewrite" or "skill".');
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
  if (input.description === undefined || input.description.trim().length === 0) {
    return fail('A rewrite needs the new description: it is the line the index shows, so it must say the corrected thing.');
  }
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
