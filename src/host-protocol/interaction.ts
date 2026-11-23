/**
 * Interactions: what the Host waits for a person to answer before a Run goes
 * on. Either the model asked a question, or a tool is about to do something
 * that needs permission. Every person attached to the Session sees the pending
 * ones in its view. The first valid answer settles an interaction; an answer
 * that arrives later is told so and changes nothing.
 */
import { z } from 'zod/v4';

import { hostCommandParams, hostList, hostParams, hostResult, type HostMethodRegistry } from './schema.js';
import { SessionRef } from './session.js';

const InteractionRef = z.string().min(1).max(256);
const GrantRef = z.string().min(1).max(256);

const Choice = z.object({ label: z.string(), description: z.string().optional(), value: z.string() });

/** What a question with choices allows besides picking one of them. */
const CHOICE_RULES = {
  /** The answer is a list of choices. The two bounds apply to its length. */
  multiSelect: z.boolean().optional(),
  minSelections: z.number().optional(),
  maxSelections: z.number().optional(),
  /** A suggestion to show. It is not the answer unless the person picks it. */
  default: z.string().optional(),
  /** Unless this is false, the person may type an answer of their own instead of picking one. */
  allowCustomInput: z.boolean().optional(),
  customInputLabel: z.string().optional(),
  customInputPrompt: z.string().optional(),
  customInputDefault: z.string().optional(),
};

/** `input` asks for typed text; anything else offers `options` to pick from. */
const Question = z.object({
  question: z.string(),
  kind: z.string().optional(),
  options: z.array(Choice).optional(),
  ...CHOICE_RULES,
});

/** Several questions asked together. An answer names each by its `question` text. */
const Questions = z.object({
  questions: z.array(z.object({
    question: z.string(),
    header: z.string().optional(),
    options: z.array(Choice),
    ...CHOICE_RULES,
  })),
});

const TextQuestion = z.object({ question: z.string(), default: z.string().optional() });

/** What a file tool would change, worked out before asking, or what it changed once it ran. */
export const FileChange = z.object({
  /** The file inside the Host workspace. Absent when it lies outside, or the Host has no workspace. */
  path: z.string().optional(),
  added: z.int(),
  removed: z.int(),
  /** Standard unified-diff hunks, without the `---` and `+++` lines. */
  unified: z.string(),
  /** The hunks were cut at a line; `added` and `removed` count the whole change. */
  truncated: z.literal(true).optional(),
});

/** What a tool is about to do and why the Host asks first. */
const Permission = z.object({
  toolName: z.string(),
  toolCallId: z.string().optional(),
  reason: z.string().optional(),
  /** The extensions that asked for this approval, each with its reason. */
  extensionAsks: z.array(z.object({ extension: z.string(), reason: z.string() })).optional(),
  /** `low`, `medium` or `high`, for display. */
  risk: z.string().optional(),
  inputPreview: z.string().optional(),
  /** Present when the tool would change a file and the Host could work out how. */
  diff: FileChange.optional(),
  /** The whole plan, when the approval is for leaving plan mode. */
  plan: z.string().optional(),
  /**
   * Wider answers the Host offers. To give one, answer `allow_session` for a
   * `session` suggestion or `allow_always` for a `persistent` one, with its `id`.
   */
  grantSuggestions: z.array(z.object({
    id: z.string(),
    kind: z.enum(['session', 'persistent']),
    /** Says what the answer would cover, for a person to read. It may name a path on the Host and is no reference to one. */
    label: z.string(),
  })).optional(),
});

/**
 * `kind` selects what `request` holds and which answer is valid. A later
 * revision may add kinds; a client that does not know one leaves it unanswered.
 */
function interaction<Asked extends z.ZodType>(permission: Asked) {
  const pending = {
    id: z.string(),
    sessionId: z.string(),
    runId: z.string(),
    /** UTC milliseconds. */
    createdAt: z.int(),
    /** When the Host stops waiting and settles it as unanswered or refused. */
    expiresAt: z.int().optional(),
  };
  return z.discriminatedUnion('kind', [
    z.object({ ...pending, kind: z.literal('question'), request: Question }),
    z.object({ ...pending, kind: z.literal('question_multi'), request: Questions }),
    z.object({ ...pending, kind: z.literal('question_input'), request: TextQuestion }),
    z.object({ ...pending, kind: z.literal('permission'), request: permission }),
  ]);
}

export const Interaction = interaction(Permission);

/** The directory a command would run in, and the file a change is to, are paths on the Host. */
export const LocalInteraction = interaction(Permission.extend({
  executionCwd: z.string().optional(),
  diff: FileChange.extend({ hostPath: z.string() }).optional(),
}));

/** A choice's `value`, or text the person typed instead of picking one. */
const Selection = z.union([z.string(), z.strictObject({ kind: z.literal('customInput'), value: z.string() })]);
/** One selection, or a list of them for a `multiSelect` question. */
const Answer = z.union([Selection, z.array(Selection).max(256)]);

const Decision = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('allow_once') }),
  z.strictObject({ type: z.literal('allow_session'), suggestionId: z.string().min(1).max(256) }),
  z.strictObject({ type: z.literal('allow_always'), suggestionId: z.string().min(1).max(256) }),
  /** `reason` is told to the model. */
  z.strictObject({ type: z.literal('reject'), reason: z.string().max(4096).optional() }),
]);

/**
 * The first four answer the interaction of the same kind.
 *   skip    — a question goes unanswered; `non_interactive` tells the model nobody is there to ask
 *   dismiss — the person closed it: a question goes unanswered, a permission is refused
 */
const Response = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('question'), answer: Answer }),
  z.strictObject({ kind: z.literal('question_multi'), answers: z.record(z.string(), Answer) }),
  z.strictObject({ kind: z.literal('question_input'), text: z.string() }),
  z.strictObject({ kind: z.literal('permission'), decision: Decision }),
  z.strictObject({ kind: z.literal('skip'), reason: z.literal('non_interactive').optional() }),
  z.strictObject({ kind: z.literal('dismiss'), reason: z.string().max(4096).optional() }),
]);

/** A standing permission a person gave, for one Session or for good. */
const Grant = z.object({
  id: z.string(),
  /** The Session it holds in. A grant without one is not thereby a grant for every Session. */
  sessionId: z.string().optional(),
  toolName: z.string().optional(),
  /** Says what the grant covers, for a person to read. It may name a path on the Host and is no reference to one. */
  label: z.string().optional(),
  persistence: z.enum(['session', 'persistent']).optional(),
  createdAt: z.int().optional(),
});

export const INTERACTION_METHODS = {
  /** The pending interactions of one Session, or of every Session without `sessionId`. */
  'interaction.list': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ sessionId: SessionRef.optional() }),
    result: hostList(Interaction),
    localResult: hostList(LocalInteraction),
  },
  /**
   * `status` says what became of this answer:
   *   answered, unanswered, dismissed — it settled the interaction
   *   already_resolved                — another answer settled it first, it timed out, or it never existed
   * The same answer sent again under the same `requestId` gets the status it got the first time.
   * A different answer under that `requestId` fails with `conflict`.
   */
  'interaction.respond': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({ interactionId: InteractionRef, response: Response }),
    result: hostResult({ status: z.enum(['answered', 'unanswered', 'dismissed', 'already_resolved']) }),
  },

  /** `revision` changes whenever the set of grants does. */
  'permission.grant.list': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({}),
    result: hostResult({ items: z.array(Grant), revision: z.string() }),
  },
  /**
   * Succeeds when the grant is gone, whether or not this call removed it.
   * With `ifRevision`, fails with `conflict` when the grants changed since that revision was read.
   */
  'permission.grant.revoke': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({ grantId: GrantRef, ifRevision: z.string().min(1).max(64).optional() }),
    result: hostResult({}),
  },
} as const satisfies HostMethodRegistry;
