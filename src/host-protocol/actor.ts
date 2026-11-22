/**
 * Actors: the child Agents running inside a Session. The Session's own Agent
 * is the root, `/root`. Each child has a path under it, such as
 * `/root/audit`, and does its work a turn at a time. Paths and turn ids stay
 * the same across a Host restart.
 *
 * A client reads the tree and steers a child as the root. Starting a child and
 * giving one a new objective are not here yet.
 *
 * What a child wrote is named by paths on the Host, so only a role that
 * reaches the local plane is sent `artifacts`, `artifactDetails` and the
 * executor's `metadata`.
 */
import { z } from 'zod/v4';

import { hostCommandParams, hostParams, hostResult, type HostMethodRegistry } from './schema.js';
import { SessionRef } from './session.js';

const ActorPath = z.string().min(1).max(1024);
const TurnId = z.string().min(1).max(1024);

/** How far one executor invocation got. `max` is 0 when there is no limit. */
const Iteration = z.object({ current: z.int(), max: z.int() });

/** One step a turn reported: a `status`, a `tool` call or what the `assistant` said. */
const Progress = z.object({
  sequence: z.int(),
  kind: z.string(),
  summary: z.string(),
  iteration: Iteration.optional(),
  createdAt: z.int(),
});

const Actor = z.object({
  path: z.string(),
  taskName: z.string(),
  /** Absent on the root. */
  parentPath: z.string().optional(),
  /** `native`, `constructed`, `workflow` or `external`. */
  kind: z.string(),
  /** `running` while a turn is in progress, `idle` between turns, `closed` for good. */
  state: z.string(),
  capabilities: z.object({
    tools: z.array(z.string()),
    /** `none`, `read` or `write`. */
    filesystem: z.string(),
    network: z.boolean(),
    providers: z.array(z.string()),
    canAskUser: z.boolean(),
    /** What the executor behind the actor can do. Absent means everything. */
    control: z.object({
      followup: z.boolean(),
      interrupt: z.boolean(),
      streaming: z.boolean(),
      artifacts: z.boolean(),
    }).optional(),
  }),
  /** Every turn the actor had, oldest first. */
  turnIds: z.array(z.string()),
  /** The turn in progress. Absent while the actor is idle. */
  currentTurnId: z.string().optional(),
  mailboxCursor: z.int(),
  createdAt: z.int(),
  updatedAt: z.int(),
  revision: z.int(),
});

const TreeEntry = Actor.extend({
  /** The newest turn in short. Absent before the first turn. */
  latestTurn: z.object({
    turnId: z.string(),
    /** `accepted`, `running`, `completed`, `failed` or `interrupted`. */
    state: z.string(),
    summary: z.string(),
    summaryTruncated: z.boolean(),
    recentActivity: z.array(Progress),
    iteration: Iteration.optional(),
    terminationReason: z.string().optional(),
  }).optional(),
});

const Turn = z.object({
  turnId: z.string(),
  actorPath: z.string(),
  /** Counts the actor's turns from 1. */
  sequence: z.int(),
  state: z.string(),
  objective: z.string(),
  /** How much of its parent's conversation the turn started from: `all`, `none` or a number of turns. */
  forkTurns: z.union([z.string(), z.int()]),
  createdAt: z.int(),
  startedAt: z.int().optional(),
  completedAt: z.int().optional(),
  /** The whole answer. `actor.output` gives a bounded one. */
  output: z.string().optional(),
  /** The answer as data, when the objective asked for a shape. */
  structured: z.unknown().optional(),
  error: z.string().optional(),
  progress: z.array(Progress).optional(),
  iteration: Iteration.optional(),
  /** `iteration_limit` when the turn stopped at its limit and not because it was done. */
  terminationReason: z.string().optional(),
  revision: z.int(),
});

const Artifact = z.object({
  name: z.string(),
  uri: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  hash: z.string().optional(),
  provenance: z.string().optional(),
  producingAgentId: z.string().optional(),
  remoteTaskId: z.string().optional(),
});

const Written = { artifacts: z.array(z.string()).optional(), artifactDetails: z.array(Artifact).optional() };

const LocalTurn = Turn.extend({ ...Written, metadata: z.record(z.string(), z.unknown()).optional() });

/** One message in an actor's mailbox. A `completion` reports that a child's turn ended. */
const Message = z.object({
  messageId: z.string(),
  sequence: z.int(),
  senderPath: z.string(),
  recipientPath: z.string(),
  /** The sender's turn at the time. */
  turnId: z.string().optional(),
  /** `message`, `followup` or `completion`. */
  kind: z.string(),
  classification: z.string(),
  /** The actors the message passed through, first sender first. */
  lineage: z.array(z.string()).optional(),
  forwardedMessageId: z.string().optional(),
  text: z.string(),
  createdAt: z.int(),
});

const detail = <Shape extends z.ZodType>(turn: Shape) => hostResult({
  actor: Actor,
  turns: z.array(turn),
  mailbox: z.array(Message),
});

const Output = {
  actorPath: z.string(),
  turnId: z.string(),
  state: z.string(),
  /** At most the first and the last part of a long answer; `outputTruncated` says when. */
  output: z.string().optional(),
  outputTruncated: z.boolean().optional(),
  progress: z.array(Progress),
  structured: z.unknown().optional(),
  error: z.string().optional(),
  iteration: Iteration.optional(),
  terminationReason: z.string().optional(),
};

const Target = { sessionId: SessionRef, actorPath: ActorPath };

export const ACTOR_METHODS = {
  'actor.tree': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ sessionId: SessionRef }),
    result: hostResult({
      /** The root and every actor under it. */
      items: z.array(TreeEntry),
      /** Turns of children in progress, against the most the Session runs at once. */
      activeNonRootTurns: z.int(),
      maxConcurrentThreads: z.int(),
      /** Goes up with every change to the tree, its turns or its mailboxes. */
      revision: z.int(),
    }),
  },
  'actor.get': {
    primitive: 'query',
    plane: 'data',
    params: hostParams(Target),
    result: detail(Turn),
    localResult: detail(LocalTurn),
  },
  /** What one turn answered. Without `turnId`, the actor's newest turn. */
  'actor.output': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ ...Target, turnId: TurnId.optional() }),
    result: hostResult(Output),
    localResult: hostResult({ ...Output, ...Written }),
  },
  /**
   * Waits for something to happen among the Session's actors after
   * `afterSequence`, and answers without `event` when nothing did in time.
   * It is a nudge to read the tree again, not a full record: the Host keeps a
   * bounded number of events and drops the ended turns the root has taken note of.
   */
  'actor.wait': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({
      sessionId: SessionRef,
      afterSequence: z.int().min(0).optional(),
      timeoutMs: z.int().min(0).max(60_000).optional(),
    }),
    result: hostResult({
      event: z.object({
        sequence: z.int(),
        /** `actor_spawned`, `turn_started`, `message_delivered`, `turn_progress`, `turn_completed`, `turn_failed`, `turn_interrupted` or `actor_closed`. */
        kind: z.string(),
        actorPath: z.string(),
        turnId: z.string().optional(),
        parentPath: z.string().optional(),
        progress: Progress.optional(),
        createdAt: z.int(),
      }).optional(),
    }),
  },
  /** Puts a message from the root in an actor's mailbox. It starts no turn: an idle actor reads it in its next one. */
  'actor.send': {
    primitive: 'command',
    plane: 'data',
    params: hostCommandParams({
      ...Target,
      text: z.string().min(1).max(32_768),
      /** How freely the actor may pass the message on. `internal` when absent. */
      classification: z.enum(['public', 'internal', 'sensitive']).optional(),
    }),
    result: hostResult({}),
  },
  /** Ends the named turn as `interrupted`. A turn that already ended is left as it is. */
  'actor.interrupt': {
    primitive: 'command',
    plane: 'data',
    params: hostCommandParams({ ...Target, turnId: TurnId, reason: z.string().min(1).max(1024).optional() }),
    result: hostResult({}),
  },
} as const satisfies HostMethodRegistry;
