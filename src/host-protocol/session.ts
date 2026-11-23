/**
 * Sessions: the conversations a Host keeps. What a Session is working on, its
 * history and its Runs have their own methods; these create, find and retire it.
 */
import { z } from 'zod/v4';

import {
  HostId, HostPath, WorkspacePath, hostCommandParams, hostList, hostParams, hostResult, type HostMethodRegistry,
} from './schema.js';
import { CredentialLeases, RunLeases } from './lease.js';

/**
 * Names a Session that already exists. Looser than a new id: a Host still holds
 * Sessions whose ids were chosen before the id rule.
 */
export const SessionRef = z.string().min(1).max(256);

/**
 * Present only while the Session is quarantined: it refuses new Runs and heals
 * in the background, then the field goes away by itself.
 */
const SessionRecovery = z.object({
  /**
   * `recovering`: the repair is in progress. `stalled`: it has run past its
   * time limit and still retries, but a person may need to look. Treat a state
   * you do not know as `recovering`.
   */
  state: z.string(),
  /** When the Session entered quarantine. UTC milliseconds. */
  since: z.int(),
  /** Why it entered quarantine. */
  code: z.string(),
});

export const Session = z.object({
  id: z.string(),
  title: z.string(),
  tag: z.string().optional(),
  archived: z.boolean(),
  /** Where the Session works, as a path inside the Host's workspace. Absent when it works outside it. */
  project: z.string().optional(),
  branch: z.string().optional(),
  surface: z.string().optional(),
  profileId: z.string().optional(),
  /** Messages in the conversation as the model sees it now. */
  messageCount: z.int().optional(),
  /** UTC milliseconds. */
  createdAt: z.int().optional(),
  /** When a person or the model last added to the conversation. UTC milliseconds. */
  lastMessageAt: z.int().optional(),
  /** Present on a side conversation: the Session it was opened from. */
  sideChat: z.object({ parentSessionId: z.string(), boundary: z.string().nullable() }).optional(),
  /** Changes when the Session's title, tag or place does. Compare, do not parse. */
  revision: z.string().optional(),
  recovery: SessionRecovery.optional(),
});

export const LocalSession = Session.extend({
  workspaceRoot: z.string().optional(),
  gitRoot: z.string().optional(),
  executionCwd: z.string().optional(),
});

/** One of the two ways to name a project. `projectRoot` is a Host path, so only the owner may send it. */
export const ProjectChoice = { project: WorkspacePath.optional(), projectRoot: HostPath.optional() };
export const PROJECT_CHOICE_RESTRICTED = { projectRoot: 'local' } as const;

/** Application rules and references for the model, in the order it reads them. */
export const PromptSpec = z.strictObject({
  /** `omit` leaves out the Host's own working guidance. */
  kodaxGuidance: z.enum(['keep', 'omit']).optional(),
  /** Each key names one entry. All the text together stays within 8,000 characters. */
  context: z.array(z.strictObject({
    key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    /** A `rule` is to be followed; a `reference` is material to draw on. */
    kind: z.enum(['rule', 'reference']),
    text: z.string().regex(/\S/).max(8_000),
  })).max(64).optional(),
});

const ProfileName = z.string().min(1).max(128).optional();

/** Limits on one Run. Where the Session and the Run both set one, the lower holds. */
export const RunBudget = z.strictObject({
  /** The most model turns the Run may take. */
  maxIter: z.int().min(1).optional(),
  /**
   * The longest the Run may work, in milliseconds, counted from when it starts
   * working and including time it waits for a person. The Host stops a Run
   * that reaches it; its outcome then has the code `time_limit`.
   */
  maxDurationMs: z.int().min(1).max(2 ** 31 - 1).optional(),
});

/**
 * What the creator of a Session fixes for every Run of it, whoever submits the
 * Run. A Run can narrow each of these and widen none. A Session that fixes
 * nothing has the empty policy.
 */
const SessionPolicy = z.strictObject({
  /** The only tools a Run may use, by name. Absent leaves the Host's own limit. */
  tools: z.array(z.string().regex(/\S/).max(256)).max(512).optional(),
  budget: RunBudget.optional(),
  /** Who the model is in this Session. */
  agentProfile: z.strictObject({
    id: ProfileName,
    name: ProfileName,
    version: ProfileName,
    surface: ProfileName,
    instructions: z.string().regex(/\S/).max(32_000).optional(),
  }).optional(),
  /** What every Run starts with. A Run adds its own entries after these. */
  prompt: PromptSpec.optional(),
  /**
   * Whether a Run puts its questions and approval requests to a person.
   * `wait` shows them to the clients attached and waits as long as the Host
   * allows. `reject` answers them at once: the model is told that nobody is
   * there to ask, and a tool call that needs approval is not run. A Session a
   * service creates without saying is `reject`; one a person creates is `wait`.
   */
  interactions: z.enum(['wait', 'reject']).optional(),
  /**
   * Leases of the creator that every Run of the Session uses, whoever submits
   * it. Their requests go to the client instance that bound them, which must
   * hold them and connect with an `instanceSecret`. A Run there brings no
   * leases of its own. While that instance is away, a Run that needs the key
   * is refused with `unavailable`, and a tool call waits for it to come back.
   * After a Host restart it registers again under the same `requestId`.
   */
  leases: RunLeases.optional(),
});

/**
 * What a Session works toward across its Runs, until it is done or stopped.
 *   active         — being worked on
 *   paused         — set aside by a person
 *   budget_limited — stopped at its `tokenBudget`
 *   blocked        — the model reported that it cannot go on; `blocker` names why
 *   complete       — done
 */
const Goal = z.object({
  id: z.string(),
  objective: z.string(),
  status: z.enum(['active', 'paused', 'budget_limited', 'blocked', 'complete']),
  /** The most tokens the goal may use. Absent when it has no limit. */
  tokenBudget: z.number().optional(),
  tokensUsed: z.number(),
  timeUsedSeconds: z.number(),
  /** The kind of obstacle the model last reported. */
  blocker: z.string().optional(),
  /** UTC milliseconds. */
  createdAt: z.number(),
  updatedAt: z.number(),
});

/**
 * One entry of the conversation tree. A conversation that goes back to an
 * earlier entry keeps what came after as a branch, so its entries form a tree.
 * `type` says what the entry records: a `message`, a `label` put on another
 * entry, a `branch_summary`, a `client_notice`, and others a Host may add.
 */
const TreeEntry = z.object({
  id: z.string(),
  /** The entry this one follows. Absent on the first. */
  parentId: z.string().optional(),
  type: z.string(),
  /** UTC milliseconds. */
  createdAt: z.int().optional(),
  /** On a message: who said it. */
  role: z.string().optional(),
  /** The start of what the entry says, for display. */
  preview: z.string().optional(),
  /** On a label or a rewind: the entry it points at. */
  targetId: z.string().optional(),
  /** On a label. Absent when the entry records that the label was taken off. */
  label: z.string().optional(),
  /** On a rewind: how many entries it left behind. */
  truncatedCount: z.int().optional(),
});

/**
 * An entry of the conversation tree, by its id or by a label put on it. When
 * no entry matches, a command fails with `conflict` and the reason
 * `entry_not_found`, which tells it from a Session that is running.
 */
const EntryRef = z.string().min(1).max(256);

/**
 * A turn of the conversation as `history.resolveTurn` named it. It stands for
 * the conversation as it was read then. Once the conversation changes, a
 * command handed the turn fails with `resync_required`, and the client names
 * the turn again.
 */
export const TurnRef = z.string().min(1).max(4096);

const SessionCommand = hostCommandParams({ sessionId: SessionRef });
const Done = hostResult({});
const SessionAnswer = { result: hostResult({ session: Session }), localResult: hostResult({ session: LocalSession }) };
const GoalAnswer = hostResult({ goal: Goal });

export const SESSION_METHODS = {
  'session.list': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({
      ...ProjectChoice,
      includeArchived: z.boolean().optional(),
      tag: z.string().min(1).max(128).optional(),
      surface: z.string().min(1).max(64).optional(),
      limit: z.int().min(1).max(200).optional(),
      cursor: z.string().min(1).max(1024).optional(),
    }),
    restricted: PROJECT_CHOICE_RESTRICTED,
    result: hostList(Session),
    localResult: hostList(LocalSession),
  },
  'session.get': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ sessionId: SessionRef }),
    // `phase` is `idle` or the phase of the Run that decides what the Session is doing; `runId` names that Run.
    result: hostResult({ session: Session, phase: z.string(), runId: z.string().optional() }),
    localResult: hostResult({ session: LocalSession, phase: z.string(), runId: z.string().optional() }),
  },
  'session.create': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      ...ProjectChoice,
      title: z.string().max(200).optional(),
      tag: z.string().min(1).max(128).optional(),
      surface: z.string().min(1).max(64).optional(),
      profileId: z.string().min(1).max(128).optional(),
      /** Fixed for the life of the Session and kept by a fork of it. */
      policy: SessionPolicy.optional(),
      /**
       * The name of an Agent from `agent.list`. The Session is created as that
       * Agent: its instructions and tools are copied into the policy, where they
       * narrow what `policy` fixes, and the Session starts on its model. A later
       * change to the Agent does not reach the Session. Fails with `not_found`
       * when no such Agent is installed, and with `invalid_params` when
       * `policy.agentProfile` is sent as well.
       */
      agent: z.string().min(1).max(128).optional(),
      /**
       * Held in the Host's memory until its first input is saved, so a
       * conversation a person opens and never uses leaves nothing behind. A
       * Host that restarts first no longer has it.
       */
      draft: z.boolean().optional(),
    }),
    restricted: { ...PROJECT_CHOICE_RESTRICTED, policy: 'trusted' },
    result: hostResult({ session: Session }),
    localResult: hostResult({ session: LocalSession }),
  },
  /** What binds every Run of the Session. Anyone who can reach the Session may read it. */
  'session.policy.get': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ sessionId: SessionRef }),
    result: hostResult({ policy: SessionPolicy }),
  },
  /**
   * Replaces the whole policy, for the Runs that start from then on. A Run
   * already working keeps the policy it started with. Leases in it are bound
   * as `session.create` binds them, to the client instance that sends this.
   */
  'session.policy.update': {
    primitive: 'command',
    resend: 'auto',
    plane: 'trusted',
    params: hostCommandParams({ sessionId: SessionRef, policy: SessionPolicy }),
    result: hostResult({ policy: SessionPolicy }),
  },
  // Each of these names a state, so sending one again changes nothing.
  'session.archive': { primitive: 'command', resend: 'auto', plane: 'data', params: SessionCommand, result: Done },
  'session.unarchive': { primitive: 'command', resend: 'auto', plane: 'data', params: SessionCommand, result: Done },
  /** Succeeds when the Session is already gone: what was asked for holds. */
  'session.delete': { primitive: 'command', resend: 'auto', plane: 'data', params: SessionCommand, result: Done },
  /**
   * Gives a Session its lasting tag once, as when a quick question becomes a
   * working Session; the id and the conversation stay. `ifRevision` is the
   * Session's `revision` as the caller read it. Fails with `conflict`:
   * `revision_mismatch` when the Session changed since, so read it again;
   * `already_promoted` when another request promoted it, which no retry
   * changes. Sent again with the same `requestId`, `tag` and `ifRevision`, it
   * answers with the Session as promoted.
   */
  'session.promote': {
    primitive: 'command',
    resend: 'auto',
    plane: 'trusted',
    params: hostCommandParams({
      sessionId: SessionRef,
      ifRevision: z.string().min(1).max(128),
      tag: z.string().min(1).max(128),
    }),
    ...SessionAnswer,
  },
  /**
   * The Session as promoted by the `session.promote` sent under `promotionId`
   * as its `requestId`, for a caller who lost the answer. Fails with
   * `not_found` (`promotion_not_found`) when that request did not promote it.
   */
  'session.promotion.get': {
    primitive: 'query',
    plane: 'trusted',
    params: hostParams({ sessionId: SessionRef, promotionId: HostId }),
    ...SessionAnswer,
  },
  /**
   * Replaces the older part of the conversation with a summary, so the model
   * has room to go on. Answers once that is done, which takes as long as a
   * model call. Sent again under the same `requestId`, it answers with the
   * compaction the first one made. Fails with `conflict` while the Session is
   * running or another request is compacting it, and with `unavailable` when
   * the summary could not be made; the conversation is unchanged in both cases.
   */
  'session.compact': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      /** What the summary should take care to keep. */
      instructions: z.string().regex(/\S/).max(8_000).optional(),
      /** The summary is a model call, which gets its provider key from `leases.credential`. */
      leases: CredentialLeases.optional(),
    }),
    restricted: { leases: 'trusted' },
    result: hostResult({
      /** False when the conversation was too short to need it. */
      compacted: z.boolean(),
      /** The size of the conversation, in the model's tokens, before and after. */
      tokensBefore: z.number(),
      tokensAfter: z.number(),
    }),
  },

  /**
   * The conversation tree of the Session, the oldest entry first.
   * `activeEntryId` is where the conversation stands: the next Run goes on
   * from it. Fails with `resync_required` when the entry a `cursor` names is
   * gone; read again from the start.
   */
  'session.lineage.get': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({
      sessionId: SessionRef,
      limit: z.int().min(1).max(1000).optional(),
      cursor: z.string().min(1).max(256).optional(),
    }),
    result: hostResult({
      items: z.array(TreeEntry),
      nextCursor: z.string().optional(),
      /** Absent while the Session has no conversation. */
      activeEntryId: z.string().optional(),
    }),
  },
  /**
   * Puts a label on an entry, or takes its label off when `label` is absent.
   * Answers with the entry that records it. When the entry already carries
   * what is asked, as when this is sent again, it records nothing and answers
   * with the entry that recorded it. Fails with `conflict` when no entry
   * matches, and while the Session is running.
   */
  'session.lineage.label': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      entry: EntryRef,
      label: z.string().regex(/\S/).max(128).optional(),
    }),
    result: hostResult({ entry: TreeEntry }),
  },
  /**
   * Moves the conversation to another entry of its tree. The next Run goes on
   * from there, and what came after stays in the tree as a branch. With
   * `summarize`, a summary of the branch that is left is put after the entry,
   * so the model knows what was tried. A switch already in place changes
   * nothing, so it is safe to send again. Fails with `conflict` when no entry
   * matches, and while the Session is running; with `resync_required` when the
   * conversation no longer stands on `ifActiveEntryId`.
   */
  'session.branch.select': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      entry: EntryRef,
      summarize: z.boolean().optional(),
      /** The `activeEntryId` of the tree as the client read it. */
      ifActiveEntryId: z.string().min(1).max(256),
    }),
    result: hostResult({ session: Session }),
    localResult: hostResult({ session: LocalSession }),
  },
  /**
   * Adds a line to the conversation that people read and the model does not,
   * such as what a command of the client's own printed. `itemId` is the id of
   * the item a Session view shows the notice as; `history.read` leaves notices
   * out. Sent again under the same `requestId`, it answers with the notice it
   * added the first time. Fails with `conflict` while the Session is running.
   */
  'session.notice.append': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      text: z.string().regex(/\S/).max(64_000),
      /** What printed the notice, such as the name of a command. */
      source: z.string().regex(/\S/).max(64).optional(),
    }),
    result: hostResult({ itemId: z.string() }),
  },

  /** The goal of the Session. `goal` is absent when it has none. */
  'session.goal.get': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ sessionId: SessionRef }),
    result: hostResult({ goal: Goal.optional() }),
  },
  /**
   * Gives the Session a goal. A Session has one goal at a time, so this fails
   * with `conflict` while another goal stands that is not complete; clear that
   * one first. Asking for the goal the Session already has answers with it as
   * it stands. Also fails with `conflict` before the Session has a
   * conversation, and while it is running.
   */
  'session.goal.create': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      objective: z.string().regex(/\S/).max(8_000),
      tokenBudget: z.int().min(1).optional(),
    }),
    result: GoalAnswer,
  },
  // Pause, resume and clear each name a state, so sending one again changes nothing.
  // Each fails with `conflict` when it would change the goal while the Session is running.
  /** Sets an `active` goal aside. Fails with `conflict` for a goal in any other state but `paused`. */
  'session.goal.pause': { primitive: 'command', resend: 'auto', plane: 'data', params: SessionCommand, result: GoalAnswer },
  /** Takes a `paused` goal up again. Fails with `conflict` for a goal in any other state but `active`. */
  'session.goal.resume': { primitive: 'command', resend: 'auto', plane: 'data', params: SessionCommand, result: GoalAnswer },
  /** Leaves the Session without a goal. Succeeds when it already has none. */
  'session.goal.clear': { primitive: 'command', resend: 'auto', plane: 'data', params: SessionCommand, result: Done },

  /**
   * A new Session that starts with the conversation of this one: all of it, or
   * the part `turn` or `entry` keeps. The source is unchanged. The fork runs
   * as its source does and is bound by the same policy. Sent again under the
   * same `requestId`, it answers with the Session the first one made.
   * Fails with `conflict` while the source is running, and with
   * `resync_required` when the conversation changed since `turn` was named.
   */
  'session.fork': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      /** Keeps the conversation up to the end of this turn. Not to be sent with `entry`. */
      turn: TurnRef.optional(),
      /** Sent with `turn`: keeps what came before the turn and leaves the turn out. */
      before: z.boolean().optional(),
      /** Keeps the conversation up to this entry of the tree. */
      entry: EntryRef.optional(),
      title: z.string().max(200).optional(),
    }),
    ...SessionAnswer,
  },
  /**
   * A new Session that starts from a summary of what this one learned, for a
   * conversation that can no longer go on as it is. The summary is put
   * together without a model call. The source is unchanged, and the new
   * Session is bound by the same policy. Sent again under the same
   * `requestId`, it answers with the Session the first one made.
   * Fails with `conflict` while the source is running or has no conversation.
   */
  'session.recover': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      title: z.string().max(200).optional(),
      /** Why the conversation is being left, kept at the head of the summary. */
      reason: z.string().regex(/\S/).max(2_000).optional(),
    }),
    ...SessionAnswer,
  },
  /**
   * Takes the conversation back to where `turn` or `entry` ends: what came
   * after leaves the conversation the model reads. One of the two says where
   * to. A rewind that is already in place changes nothing, so it is safe to
   * send again.
   * Fails with `conflict` while the Session is running or `entry` names
   * nothing, and with `resync_required` when the conversation changed since
   * `turn` was named or no longer stands on `ifActiveEntryId`.
   */
  'session.rewind': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      /** Goes back to the end of this turn. Not to be sent with `entry` or `ifActiveEntryId`. */
      turn: TurnRef.optional(),
      /** Goes back to this entry of the tree. Sent with `ifActiveEntryId`. */
      entry: EntryRef.optional(),
      /** The `activeEntryId` of the tree as the client read it. A turn carries this check itself. */
      ifActiveEntryId: z.string().min(1).max(256).optional(),
    }),
    ...SessionAnswer,
  },
  /**
   * The side chat of the Session: a Session of its own that can read the
   * conversation so far and leaves it untouched. One exists for each branch of
   * the conversation and each client identity, so asking again answers with
   * the same one. Fails with `conflict` when `sessionId` is itself a side chat.
   */
  'session.side.open': { primitive: 'command', resend: 'auto', plane: 'data', params: SessionCommand, ...SessionAnswer },
} as const satisfies HostMethodRegistry;
