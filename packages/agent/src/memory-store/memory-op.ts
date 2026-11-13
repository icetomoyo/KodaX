/**
 * FEATURE_308 — the logic behind the single `memory` tool (write / edit / delete).
 *
 * Authorization is exact-quote: `userQuote` must appear verbatim in the CURRENT
 * user message, which the host supplies (never text from a tool result, so an
 * injected instruction cannot authorize a write).
 *   - write + valid quote  -> active note (the user stated it).
 *   - write, no quote      -> candidate note (inferred); needs a `why` so a later
 *                             session can corroborate it. Candidates are not indexed.
 *   - edit / delete        -> always need a valid quote.
 */
import { normalizeQuote, quoteWeight } from './quote.js';
import type { NoteScope, NoteType } from './record.js';
import type { NewNote, NoteResult, NoteStore } from './store.js';

export interface MemoryOpInput {
  readonly operation: 'write' | 'edit' | 'delete';
  readonly id: string;
  readonly scope?: NoteScope;
  readonly type?: NoteType;
  readonly description?: string;
  readonly why?: string;
  readonly check?: string;
  readonly body?: string;
  readonly userQuote?: string;
}

export interface MemoryOpContext {
  readonly stores: Readonly<Record<NoteScope, NoteStore>>;
  /** Text of the current user message, supplied by the host. */
  readonly userMessage: string;
  /** Recorded on new notes so a later session can corroborate an inferred one. */
  readonly sessionId?: string;
}

export interface MemoryOpResult {
  readonly ok: boolean;
  /** Written for the model; never contains the quote or a secret. */
  readonly message: string;
}

/** The user is present, so a short reply such as "yes, save that" is enough; one word is not. */
const MIN_QUOTE_WEIGHT = 6;

/** Returns the normalized quote when it authorizes, otherwise an error message. */
function authorize(quote: string | undefined, userMessage: string): { readonly quote: string } | { readonly error: string } {
  const normalized = normalizeQuote(quote ?? '');
  if (quoteWeight(normalized) < MIN_QUOTE_WEIGHT) {
    return { error: 'userQuote must be an exact quote from the current user message authorizing this change.' };
  }
  if (!normalizeQuote(userMessage).includes(normalized)) {
    return { error: 'userQuote was not found in the current user message. Quote the user exactly, or omit it to propose a candidate note.' };
  }
  return { quote: normalized };
}

function failure(result: Extract<NoteResult, { ok: false }>, id: string): MemoryOpResult {
  switch (result.reason) {
    case 'exists':
      return { ok: false, message: `A memory with id '${id}' already exists. Use operation "edit" to change it.` };
    case 'not-found':
      return { ok: false, message: `No memory with id '${id}'.` };
    case 'invalid-id':
      return { ok: false, message: 'id must be a short slug of letters, digits, "-" or "_" (no dots or slashes).' };
    case 'empty-description':
      return { ok: false, message: 'description must be a non-empty one-line summary.' };
    case 'secret':
      return { ok: false, message: result.detail ?? 'Secrets are never stored in memory.' };
  }
}

export async function applyMemoryOperation(context: MemoryOpContext, input: MemoryOpInput): Promise<MemoryOpResult> {
  const store = context.stores[input.scope ?? 'project'];
  switch (input.operation) {
    case 'write':
      return write(store, context, input);
    case 'edit':
    case 'delete':
      return change(store, context, input);
    default:
      return { ok: false, message: 'operation must be "write", "edit" or "delete".' };
  }
}

async function write(store: NoteStore, context: MemoryOpContext, input: MemoryOpInput): Promise<MemoryOpResult> {
  let status: NewNote['status'] = 'candidate';
  let why = input.why;
  if (input.userQuote !== undefined) {
    const auth = authorize(input.userQuote, context.userMessage);
    if ('error' in auth) return { ok: false, message: auth.error };
    status = 'active';
    why ??= `user said: "${auth.quote}"`;
  } else if (why === undefined || why.trim().length === 0) {
    return { ok: false, message: 'A note proposed without a user quote needs a "why": the evidence that makes it true.' };
  }
  const result = await store.write({
    id: input.id,
    type: input.type ?? 'project',
    description: input.description ?? '',
    why,
    ...(input.check === undefined ? {} : { check: input.check }),
    status,
    source: status === 'active' ? 'user' : 'inferred',
    ...(context.sessionId === undefined ? {} : { session: context.sessionId }),
    body: input.body ?? '',
  });
  if (!result.ok) return failure(result, input.id);
  return {
    ok: true,
    message: status === 'active'
      ? `Saved memory '${input.id}' as active.`
      : `Saved memory '${input.id}' as a candidate: it is not shown in the index until it is confirmed. If the user asked you to remember it, call "edit" on this id with their exact words as userQuote.`,
  };
}

async function change(store: NoteStore, context: MemoryOpContext, input: MemoryOpInput): Promise<MemoryOpResult> {
  const auth = authorize(input.userQuote, context.userMessage);
  if ('error' in auth) return { ok: false, message: auth.error };
  if (input.operation === 'delete') {
    const removed = await store.remove(input.id);
    return removed.ok ? { ok: true, message: `Deleted memory '${input.id}'.` } : failure(removed, input.id);
  }
  const existing = (await store.list()).find((note) => note.id === input.id);
  const edited = await store.edit(input.id, {
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.why === undefined ? {} : { why: input.why }),
    ...(input.check === undefined ? {} : { check: input.check }),
    ...(input.body === undefined ? {} : { body: input.body }),
    // The user authorized this note, so a candidate becomes active.
    ...(existing?.status === 'candidate' ? { status: 'active' as const, source: 'user' as const } : {}),
  });
  return edited.ok ? { ok: true, message: `Updated memory '${input.id}'.` } : failure(edited, input.id);
}
