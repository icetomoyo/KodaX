/**
 * The live view of a Session: what a client shows while it is attached. A
 * client subscribes under an id it chooses, is answered with the whole view,
 * and from then on receives only the changes (`view-sync.ts` computes and
 * applies them).
 *
 * How an item is represented depends on that item alone. Its text has a fixed
 * cap; a longer text is sent as its end together with the full length, and
 * `item.read` pages through all of it. So an item that did not change is never
 * sent again because another one grew.
 *
 * Values a client only shows, such as an item's `type` or a tool's `status`,
 * are open strings. A client that does not know an item type shows its text.
 */
import { z } from 'zod/v4';

import { FileChange, Interaction, LocalInteraction } from './interaction.js';
import { HostId, hostParams, hostResult, type HostMethodRegistry } from './schema.js';
import { LocalSession, Session, SessionRef } from './session.js';
import { Settings } from './settings.js';
import type { ViewOp } from './view-sync.js';
import { WorkflowSummary } from './workflow.js';

/**
 * Item ids are opaque and longer than other ids: the Host builds them from the
 * ids of the Session, the output and the provider's tool call.
 */
export const ItemId = z.string().min(1).max(512);

const Attachment = z.object({
  kind: z.string(),
  /** Reads the bytes with `blob.read`. */
  blobId: z.string(),
  mediaType: z.string().optional(),
  width: z.int().optional(),
  height: z.int().optional(),
  sha256: z.string().optional(),
});

const ToolCall = z.object({
  callId: z.string(),
  name: z.string(),
  /** A client that does not know a status goes by the item's `state`. */
  status: z.string(),
  /** The start of the input when `inputTotal` is present, otherwise all of it. */
  inputText: z.string().optional(),
  /** UTF-16 units in the whole input. */
  inputTotal: z.int().optional(),
  /** The item's `text` is a shortened output and the Host kept the complete one; `item.read` returns it. */
  outputSaved: z.boolean().optional(),
  /** What a file tool changed, once it ran. A client that shows no diffs ignores it. */
  change: FileChange.optional(),
  progress: z.string().optional(),
  startedAt: z.int().optional(),
  endedAt: z.int().optional(),
});

export const ViewItem = z.object({
  id: z.string(),
  type: z.string(),
  /** A live item may still change. A settled one changes only when history is rewritten. */
  state: z.enum(['live', 'settled']),
  /** The end of the text when `textTotal` is present, otherwise all of it. */
  text: z.string(),
  /** UTF-16 units in the whole text. */
  textTotal: z.int().optional(),
  at: z.int().optional(),
  runId: z.string().optional(),
  /** The accepted inputs a user item stands for, the first one leading. */
  inputIds: z.array(z.string()).optional(),
  attachments: z.array(Attachment).optional(),
  tool: ToolCall.optional(),
  /**
   * What a notice the Host wrote is about, so a client can show it its own way:
   * `retry` (a rate limit, a wait or a stream recovery) or `compaction`. A client
   * that does not know a kind shows the text.
   */
  notice: z.object({ kind: z.string() }).optional(),
});

/** The owner on the Host's machine also gets where each attachment is, and the file a tool changed. */
export const LocalViewItem = ViewItem.extend({
  attachments: z.array(Attachment.extend({ path: z.string() })).optional(),
  tool: ToolCall.extend({ change: FileChange.extend({ hostPath: z.string() }).optional() }).optional(),
});

const Run = z.object({
  id: z.string(),
  phase: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  error: z.string().optional(),
});

const QueuedInput = z.object({
  id: z.string(),
  /** A preview. Withdrawing the input returns its whole text. */
  text: z.string(),
  enqueuedAt: z.int(),
  admissionError: z.object({ code: z.string(), message: z.string() }).optional(),
});

const ContextBudget = z.object({
  scope: z.string(),
  provider: z.string(),
  model: z.string(),
  contextWindow: z.number(),
  reservedResponseTokens: z.number(),
  reservedMemoryTokens: z.number().optional(),
  contextId: z.string().optional(),
  compaction: z.object({
    enabled: z.boolean(),
    triggerPercent: z.number(),
    absoluteTriggerTokens: z.number().optional(),
    triggerTokens: z.number().optional(),
    physicalCapacityTokens: z.number().optional(),
  }),
});

/** Progress of the latest Run. None of it is saved as conversation history. */
const Activity = z.object({
  runId: z.string(),
  reasoning: z.object({
    providerRequestId: z.string().optional(),
    provider: z.string(),
    model: z.string(),
    requestedEffort: z.string(),
    sentEffort: z.string().optional(),
    verified: z.boolean(),
    fallbacks: z.array(z.object({ effort: z.string().optional(), reason: z.string() })),
  }).optional(),
  /** What the provider is sending right now: `kind` is `thinking` or `tool-input`. */
  streaming: z.object({
    kind: z.string(),
    providerRequestId: z.string(),
    itemId: z.string().optional(),
    toolName: z.string().optional(),
    callId: z.string().optional(),
    charCount: z.number().optional(),
    estimatedTokenCount: z.number().optional(),
  }).optional(),
  contextBudget: ContextBudget.optional(),
  costReport: z.string().optional(),
  children: z.array(z.object({
    id: z.string(),
    label: z.string(),
    source: z.string(),
    kind: z.string(),
    detail: z.string(),
    status: z.string(),
    startedAt: z.int(),
  })).optional(),
  managedTask: z.object({
    childFanoutClass: z.string().optional(),
    harnessProfile: z.string().optional(),
    globalWorkBudget: z.number().optional(),
    budgetUsage: z.number().optional(),
    budgetApprovalRequired: z.boolean().optional(),
    phase: z.string().optional(),
    workerId: z.string().optional(),
    workerTitle: z.string().optional(),
    breadcrumb: z.string().optional(),
    expandedBreadcrumb: z.string().optional(),
    round: z.number().optional(),
    maximumRounds: z.number().optional(),
    idleWaiting: z.boolean(),
    pendingChildren: z.number().optional(),
    fanoutCount: z.number().optional(),
  }).optional(),
  compacting: z.boolean().optional(),
  iteration: z.object({ current: z.number(), maximum: z.number() }).optional(),
  context: z.object({ tokenCount: z.number(), tokenSource: z.string(), scope: z.string() }).optional(),
  parentContextTokens: z.number().optional(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    thoughtTokens: z.number().optional(),
  }).optional(),
  todos: z.array(z.object({
    id: z.string(),
    subject: z.string(),
    status: z.string(),
    description: z.string().optional(),
    owner: z.string().optional(),
    note: z.string().optional(),
    activeForm: z.string().optional(),
  })).optional(),
});

/** Whether shell commands in this Session ran sandboxed the last time one ran. */
export const Sandbox = z.object({
  state: z.string(),
  backend: z.string().optional(),
  policyId: z.string().optional(),
  reason: z.string().optional(),
  execution: z.string().optional(),
});

/** The directories the sandbox lost read access to are paths on the Host. */
export const LocalSandbox = Sandbox.extend({ degradedReadRoots: z.array(z.string()).optional() });

/**
 * The top-level keys of a Session view. A `set` operation carries exactly one
 * of them, so this is also the list of what a patch may change besides items.
 * A later revision adds keys here; an older client keeps and ignores them.
 */
const SESSION_VIEW_KEYS = {
  /** The Session as `session.get` returns it, so a client sees it enter, stall in and leave quarantine. */
  session: Session,
  runs: z.array(Run),
  queue: z.array(QueuedInput),
  /** What the Session waits for a person to answer. */
  interactions: z.array(Interaction),
  /** What is in effect for the Session: its own choices, and the Host's default where it made none. */
  settings: Settings,
  activity: Activity.optional(),
  contextBudget: ContextBudget.optional(),
  parentContextTokens: z.number().optional(),
  sandbox: Sandbox.optional(),
  /** The workflows the Session started, newest first, at most 50. Older ones are read with `workflow.list`. */
  workflows: z.array(WorkflowSummary),
};

const LOCAL_SESSION_VIEW_KEYS = {
  ...SESSION_VIEW_KEYS,
  session: LocalSession,
  interactions: z.array(LocalInteraction),
  sandbox: LocalSandbox.optional(),
};

/**
 * Everything the Host sends about one kind of view, built from its item and
 * its keys. The Host passes what it sends through these, so a field the
 * contract does not name never leaves, inside a snapshot or inside a patch.
 */
function viewDocument<Item extends z.ZodType, Keys extends Readonly<Record<string, z.ZodType>>>(item: Item, keys: Keys) {
  const view = z.object({ items: z.array(item), ...keys });
  const op = z.union([
    z.object({ op: z.literal('item.put'), item, before: z.string().optional() }),
    z.object({ op: z.literal('item.remove'), id: z.string() }),
    z.object({ op: z.literal('item.append'), id: z.string(), field: z.literal('text'), text: z.string() }),
    ...Object.entries(keys).map(([key, value]) => z.object({
      op: z.literal('set'),
      key: z.literal(key),
      value: value.optional(),
    })),
  ]);
  /** Where the copy stands: a patch applies only to the snapshot or patch numbered right before it. */
  const position = { subscriptionId: HostId, epoch: z.string().min(1), seq: z.int().min(0) };
  return {
    view,
    snapshot: hostResult({ ...position, snapshot: view }),
    patch: hostResult({ ...position, ops: z.array(op) }),
  };
}

/** `incidentId` names an `internal` end in the Host log, as on an `internal` error. */
const ViewClosed = hostResult({ subscriptionId: HostId, reason: z.string(), incidentId: z.string().optional() });

const shared = viewDocument(ViewItem, SESSION_VIEW_KEYS);
const local = viewDocument(LocalViewItem, LOCAL_SESSION_VIEW_KEYS);

export const SessionView = shared.view;
export const LocalSessionView = local.view;

export type ViewItem = z.output<typeof ViewItem>;
export type SessionView = z.output<typeof SessionView>;
/** What the owner on the Host's own machine holds: the view, plus Host paths. */
export type LocalViewItem = z.output<typeof LocalViewItem>;
export type LocalSessionView = z.output<typeof LocalSessionView>;

/** The whole view at one position: the answer to subscribing, and the body of `view.reset`. */
export type ViewSnapshot = z.output<typeof shared.snapshot>;

/** A patch as a client reads it: a key or an operation it does not know is not an error. */
export interface ViewPatch {
  readonly subscriptionId: string;
  readonly epoch: string;
  readonly seq: number;
  readonly ops: readonly ViewOp<ViewItem>[];
}

export const VIEW_METHODS = {
  'view.subscribe': {
    primitive: 'subscription',
    plane: 'data',
    params: hostParams({
      /** Chosen by the client, so it can end a subscription whose answer it never received. */
      subscriptionId: HostId,
      target: z.strictObject({ kind: z.literal('session'), sessionId: SessionRef }),
    }),
    result: shared.snapshot,
    localResult: local.snapshot,
  },
  /** Succeeds whether or not the subscription still exists. */
  'view.unsubscribe': {
    primitive: 'subscription',
    plane: 'data',
    params: hostParams({ subscriptionId: HostId }),
    result: hostResult({}),
  },
  'item.read': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({
      sessionId: SessionRef,
      itemId: ItemId,
      /** `text` when absent. `output` is the complete output a tool item's `outputSaved` announces. */
      part: z.enum(['text', 'input', 'output']).optional(),
      /** From a previous page of the same part. Absent for the first page. */
      cursor: z.string().min(1).max(512).optional(),
    }),
    result: hostResult({
      text: z.string(),
      /** UTF-16 units in the whole part. */
      total: z.int(),
      nextCursor: z.string().optional(),
    }),
  },
} as const satisfies HostMethodRegistry;

/**
 * What the Host sends on its own after a subscription. A client never calls
 * these, so they are not in the method table. `localParams` is what a role
 * that reaches the local plane is sent instead.
 */
export const VIEW_NOTIFICATIONS = {
  /** The changes since the previous position. */
  'view.patch': { params: shared.patch, localParams: local.patch },
  /** The whole view again, after the Host had to drop patches for a slow client. */
  'view.reset': { params: shared.snapshot, localParams: local.snapshot },
  /** The Host ended the subscription, for example because the Session is gone. The client may subscribe again. */
  'view.closed': { params: ViewClosed, localParams: ViewClosed },
} as const;
