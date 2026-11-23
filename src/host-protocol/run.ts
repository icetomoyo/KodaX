/**
 * Inputs and Runs. An input is what a person or a service asks a Session to
 * work on; a Run is the work the Host does for it. Submitting an input is
 * accepted at once and answers with the input's state, not with its result:
 * the result is read from the Session view or from the Run.
 */
import { z } from 'zod/v4';

import {
  HostPath, hostCommandParams, hostList, hostParams, hostResult, type HostMethodRegistry,
} from './schema.js';
import { BlobAttachment } from './blob.js';
import { RunLeases } from './lease.js';
import { PromptSpec, RunBudget, SessionRef } from './session.js';

/** Names a Run or an input that already exists. Looser than a new id, for the reason `SessionRef` is. */
const RunRef = z.string().min(1).max(256);
const InputRef = z.string().min(1).max(256);

/**
 * Where an input stands.
 *   queued    — waits for its turn; can still be withdrawn
 *   submitted — in the conversation; `runId` names the Run that works on it
 *   withdrawn — taken back before it was delivered
 *   dropped   — the Run it was meant for ended first; it never entered the conversation
 */
const Input = z.object({
  id: z.string(),
  state: z.enum(['queued', 'submitted', 'withdrawn', 'dropped']),
  runId: z.string().optional(),
  /** Present on a queued input that cannot start as things are. `code` says what is missing. */
  admissionError: z.object({ code: z.string(), message: z.string() }).optional(),
});

/** `steer` and `redirect` act on a Run in progress, so they name it in `targetRunId`. */
const Delivery = z.enum(['immediate', 'after_turn', 'steer', 'redirect']);

/** A file on the Host's own machine that the input refers to. */
const LocalAttachment = z.strictObject({
  kind: z.enum(['image', 'file', 'video']),
  path: HostPath,
  mediaType: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(256).optional(),
  source: z.enum(['user-inline', 'clipboard', 'drag-drop', 'file-picker']).optional(),
  description: z.string().max(1024).optional(),
});

/** What was submitted, given back so it can be edited and sent again under a new id. */
const WithdrawnInput = z.object({
  id: z.string(),
  text: z.string(),
  delivery: z.string().optional(),
  targetRunId: z.string().optional(),
});

/**
 * How a Run ended. `status` and `effects` are separate facts: a Run can be
 * known to have failed while what it changed is not known.
 *   cancelled   — stopped before it did anything
 *   interrupted — stopped part-way: by a Stop, at its time limit (`time_limit`),
 *                 or because the Host ended; `code` says which
 * A status of `unknown` means the Host cannot tell yet whether the Run ended;
 * a later read may answer with what happened.
 */
const RunOutcome = z.object({
  status: z.enum(['completed', 'failed', 'cancelled', 'interrupted', 'unknown']),
  /** Whether what the Run changed outside the conversation is known. */
  effects: z.enum(['none', 'known', 'unknown']),
  /** Stable, for programs. More codes may be added. */
  code: z.string(),
  message: z.string().optional(),
  /** Why a failed Run failed. `detail` is the underlying reason as the provider or the system gave it. */
  failure: z.object({
    kind: z.string(),
    stage: z.string(),
    code: z.string(),
    safeMessage: z.string(),
    detail: z.string().optional(),
    skillName: z.string().optional(),
    retryAfterMs: z.number().optional(),
  }).optional(),
  /**
   * The model's last text, unless the Run was stopped. It is cut at 64,000
   * characters; `finalTextTruncated` says so, and the Session's history holds
   * all of it. `run.list` leaves both out: read the Run for them.
   */
  finalText: z.string().optional(),
  finalTextTruncated: z.boolean().optional(),
  /**
   * How the task ended: `complete`, `blocked` when something stopped it before
   * it was done (a hook can), or `decide` when a person must choose.
   * `signalReason` says why, when there is a reason.
   */
  signal: z.enum(['complete', 'blocked', 'decide']).optional(),
  signalReason: z.string().optional(),
  /** The Run ended because it used all its turns (`maxIter`). */
  limitReached: z.boolean().optional(),
  /** What the whole Run used. Absent when a model call did not report it. */
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
    cachedReadTokens: z.number().optional(),
    cachedWriteTokens: z.number().optional(),
  }).optional(),
});

/** A Run is in progress until it has an `outcome`. Branch on that, not on `phase`. */
const Run = z.object({
  id: z.string(),
  sessionId: z.string(),
  /** What the Run is doing, for display. */
  phase: z.string(),
  /** The input the Run was started for, when it was started for one. */
  inputId: z.string().optional(),
  provider: z.string(),
  model: z.string().optional(),
  /** UTC milliseconds. */
  startedAt: z.int().optional(),
  endedAt: z.int().optional(),
  /**
   * Present once the Run was asked to stop, by a Stop or by the Host at the
   * Run's time limit. The Run has stopped when `outcome` says so.
   */
  stop: z.object({ requestedAt: z.int().optional(), confirmed: z.boolean() }).optional(),
  outcome: RunOutcome.optional(),
});

const Done = hostResult({});

/** What a command answers: the Run it started, or what the Host did itself. */
const CommandAnswer = hostResult({
  /** The Run the command started. Absent when the Host finished the command itself. */
  run: Run.optional(),
  /** Whether a command the Host finished itself did what was asked. Absent with `run`: the outcome of the Run tells. */
  success: z.boolean().optional(),
  /** What the command says to the person. */
  message: z.string().optional(),
});

export const RUN_METHODS = {
  /**
   * The input's id is the `requestId`, so a client that lost the answer reads
   * `input.get` under the id it sent. Sent again, the same input starts nothing new.
   *
   * `budget` and `prompt` are for the Run of this input alone. They narrow
   * what the Session allows and cannot widen it. An input that carries either
   * starts a Run of its own: it is not joined with other waiting inputs, and
   * it cannot `steer`, because a steer joins a Run that is already working.
   */
  'input.submit': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      text: z.string().regex(/\S/),
      delivery: Delivery.optional(),
      targetRunId: RunRef.optional(),
      localAttachments: z.array(LocalAttachment).min(1).max(32).optional(),
      /** Images the Session holds, uploaded with `blob.*`. */
      attachments: z.array(BlobAttachment).min(1).max(32).optional(),
      budget: RunBudget.optional(),
      /**
       * Read by the model after the entries of the Session. An entry may not
       * reuse a key of the Session. They hold for this Run: the next Run of the
       * Session tells the model that they are no longer available.
       */
      prompt: PromptSpec.optional(),
      leases: RunLeases.optional(),
    }),
    restricted: { localAttachments: 'local', budget: 'trusted', prompt: 'trusted', leases: 'trusted' },
    result: hostResult({ input: Input }),
  },
  'input.get': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ sessionId: SessionRef, inputId: InputRef }),
    result: hostResult({ input: Input }),
  },
  /** Takes back a queued input. Sent again, it answers the same. */
  'input.withdraw': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({ sessionId: SessionRef, inputId: InputRef }),
    result: hostResult({ input: WithdrawnInput }),
    localResult: hostResult({
      input: WithdrawnInput.extend({ localAttachments: z.array(LocalAttachment).optional() }),
    }),
  },

  'run.get': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ runId: RunRef }),
    result: hostResult({ run: Run }),
  },
  /** The Runs of a Session, the newest first. */
  'run.list': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({
      sessionId: SessionRef,
      limit: z.int().min(1).max(200).optional(),
      cursor: z.string().min(1).max(256).optional(),
    }),
    result: hostList(Run),
  },
  /**
   * Answers once the Run has an outcome. Fails with `timeout` when `timeoutMs`
   * passes first; the Run goes on, and asking again is safe.
   */
  'run.wait': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ runId: RunRef, timeoutMs: z.int().min(0).max(60_000).optional() }),
    result: hostResult({ run: Run }),
  },
  /** Asks the Run to stop. The answer says the request was recorded; the Run's `outcome` says how it ended. */
  'run.stop': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({ runId: RunRef }),
    result: Done,
  },
  /**
   * Runs one tool a person named, without asking the model. The tool passes
   * the permission checks a tool the model calls passes, and what it did
   * enters the conversation. The `requestId` is the id of the input, as for
   * `input.submit`: sent again, it answers with the Run it started. A tool the
   * Host does not have, or one that was refused, is a Run that failed. The
   * request itself fails with `conflict` while the Session is running.
   */
  'run.startTool': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      /** The tool, by the name the Host knows it under. */
      tool: z.string().regex(/\S/).max(256),
      input: z.record(z.string(), z.unknown()),
      /** What the person typed. It is their message in the conversation. */
      text: z.string().regex(/\S/),
      leases: RunLeases.optional(),
    }),
    restricted: { leases: 'trusted' },
    result: hostResult({ run: Run }),
  },
  /**
   * Runs a command under the name `command.list` gives it, as a person does
   * who types `/name args`. A command that works through the model or a tool
   * starts a Run and is answered with it. A command the Host finishes itself
   * is answered with `success`. The Session must not be at work, because the
   * command acts on it; `help` as the first of `args` only asks what the
   * command is for and is answered at any time. Fails with `not_found` when no
   * command a person may run has the name.
   */
  'command.execute': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      name: z.string().regex(/\S/).max(256),
      /** What the person typed after the name, word by word. */
      args: z.array(z.string()).optional(),
      leases: RunLeases.optional(),
    }),
    restricted: { leases: 'trusted' },
    result: CommandAnswer,
  },
  /**
   * Reviews the changes in the Session's project, as a person does who types
   * `/review args`. `args` choose what to compare, such as `--staged`,
   * `base` or a commit, and how: `--lean` for a short review, `--workflow`
   * for one split among several agents, and words after `--` for what to
   * look at. A review starts a Run. With no changes to review, or `args` it
   * cannot read, the Host answers with `success` and a `message` instead.
   * The Session must not be at work.
   */
  'review.start': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      /** What the person typed after `/review`, word by word. */
      args: z.array(z.string()).optional(),
      leases: RunLeases.optional(),
    }),
    restricted: { leases: 'trusted' },
    result: CommandAnswer,
  },
  /**
   * Has the model add KodaX's guidance for small, focused changes to the
   * project's AGENTS.md where it is missing, as a person does who types
   * `/agents lean`. The model may edit AGENTS.md. Starts a Run. Without an
   * AGENTS.md the Host answers with `success` false and a `message`. The
   * Session must not be at work.
   */
  'agent.reviewLean': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({ sessionId: SessionRef, leases: RunLeases.optional() }),
    restricted: { leases: 'trusted' },
    result: CommandAnswer,
  },
  /**
   * Continues a Run that stopped part-way at a point it can go on from, which
   * is where a Host that shuts down leaves the Run it was working on. Such a
   * Run has the phase `recovering` and no outcome. Only who started the Run may
   * continue it. Safe to send for any Run: one that is not waiting to be
   * continued is answered as it stands. Fails with `conflict` while a waiting
   * Run cannot go on: the Host that runs it is still at work, or the
   * conversation moved on since it stopped.
   */
  'run.recover': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({ runId: RunRef, leases: RunLeases.optional() }),
    restricted: { leases: 'trusted' },
    result: hostResult({ run: Run }),
  },
  /**
   * Stops everything the Session is doing, provided `ifRunId` is still its
   * current Run: a Stop that arrives late must not end work started after it.
   */
  'session.cancel': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({ sessionId: SessionRef, ifRunId: RunRef }),
    result: Done,
  },
} as const satisfies HostMethodRegistry;
