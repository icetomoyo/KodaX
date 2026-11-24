/**
 * Statistics: what a Session asked of its model and of its tools, counted by
 * the Host as it happened. The counts outlive the connection and a Host
 * restart.
 *
 * Requests and tool calls are read a page at a time, oldest first. The Host
 * keeps the counts of the Sessions read most recently at hand. A cursor into
 * counts it has let go of fails with `resync_required`, and the client starts
 * again from the first page.
 */
import { z } from 'zod/v4';

import { hostParams, hostResult, type HostMethodRegistry } from './schema.js';
import { SessionRef } from './session.js';
import { LocalSandbox, Sandbox } from './view.js';

/**
 * What a count belongs to. `kind` says which: a `run`, one `actor_turn` of a
 * child Agent, or an `operation` the Host carried out, such as a compaction.
 */
const Target = z.object({
  kind: z.string(),
  runId: z.string().optional(),
  actorPath: z.string().optional(),
  turnId: z.string().optional(),
  /** The Run a child Agent's turn was part of. */
  parentRunId: z.string().optional(),
  operationId: z.string().optional(),
  operation: z.string().optional(),
});

const Usage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  thoughtTokens: z.number().optional(),
});

/** How full one context was when the Host last prepared a request for it. An estimate, not a bill. */
const Context = z.object({
  target: Target,
  contextId: z.string().optional(),
  /** `root` for the Session's own conversation, `child` for a child Agent's. */
  contextKind: z.string().optional(),
  parentContextId: z.string().optional(),
  agentId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  profile: z.string(),
  contextWindow: z.number(),
  smallWindow: z.boolean(),
  pressure: z.string(),
  tokenBreakdown: z.object({
    systemPrompt: z.number(),
    toolSchemas: z.number(),
    skillCatalog: z.number(),
    mcpCatalog: z.number(),
    transcript: z.number(),
    pendingInput: z.number(),
    recentToolResults: z.number(),
    reservedResponse: z.number(),
    total: z.number(),
  }),
  usedTokens: z.number(),
  availableTokens: z.number(),
  usedRatio: z.number(),
  toolSchemaRatio: z.number(),
  recommendations: z.array(z.string()),
  compactionBudget: z.object({
    triggerPercent: z.number(),
    absoluteTriggerTokens: z.number().optional(),
    triggerTokens: z.number(),
    physicalCapacityTokens: z.number(),
    reservedResponseTokens: z.number(),
    reservedMemoryTokens: z.number(),
  }).optional(),
  createdAt: z.int(),
  revision: z.int(),
  contextRevision: z.int().optional(),
});

const Stats = z.object({
  /** Goes up with every count the Host adds. */
  revision: z.int(),
  /** `partial` when the Host could not see every request; `issues` says why. */
  coverage: z.string(),
  issues: z.array(z.string()),
  /** The sum over the requests whose provider reported usage. */
  usage: Usage,
  requestCount: z.int(),
  requestsWithoutUsage: z.int(),
  /** Requests the Host saw go out on the wire. The rest it knows only as operations of a provider adapter. */
  physicalRequestCount: z.int(),
  operationCount: z.int(),
  contexts: z.array(Context),
});

/** One request to a model provider. */
const Request = z.object({
  id: z.string(),
  /** The same for every attempt at one request. */
  logicalId: z.string(),
  /** The request before this one on the same fallback chain. */
  previousId: z.string().optional(),
  provider: z.string(),
  model: z.string().optional(),
  /** What the request was for, such as `primary`, `compaction` or `classifier`. */
  purpose: z.string(),
  /** Who in the Run sent it, when that is not the Run itself. */
  attribution: z.object({
    kind: z.string(),
    actorPath: z.string().optional(),
    turnId: z.string().optional(),
    workflowRunId: z.string().optional(),
  }).optional(),
  attempt: z.int(),
  /** True when it went to a provider other than the first choice. */
  fallback: z.boolean(),
  route: z.object({ chainId: z.string(), attempt: z.int(), fromProvider: z.string().optional() }).optional(),
  /** `physical_attempt` for a request seen on the wire, `provider_operation` for one known only to its adapter. */
  boundary: z.string(),
  dispatch: z.string(),
  wireObservation: z.string().optional(),
  /** `started`, `succeeded`, `failed`, `cancelled`, or `unknown` when the Host stopped before it ended. */
  state: z.string(),
  recovery: z.string().optional(),
  startedAt: z.int(),
  endedAt: z.int().optional(),
  usage: Usage.optional(),
  /** What had arrived when a stream broke off. Never a complete count. */
  partialUsage: Usage.optional(),
  target: Target,
  revision: z.int(),
});

const tool = <Observed extends z.ZodType>(sandbox: Observed) => z.object({
  id: z.string(),
  /** The id the model gave the call. */
  toolId: z.string(),
  name: z.string(),
  /** `prepared`, `executing`, `completed`, `not_executed`, or `unknown` when the Host stopped before it ended. */
  state: z.string(),
  /** `succeeded`, `failed` or `cancelled`, once it completed. */
  result: z.string().optional(),
  updatedAt: z.int(),
  target: Target,
  /** What the sandbox reported for each command the call ran, in order. Empty when none reported. */
  sandbox: z.array(sandbox),
  revision: z.int(),
});

const PageParams = hostParams({
  sessionId: SessionRef,
  limit: z.int().min(1).max(500).optional(),
  cursor: z.string().min(1).max(1024).optional(),
});

/** Oldest first. `revision` is the Stats revision the page was read at. */
const page = <Item extends z.ZodType>(item: Item) => hostResult({
  items: z.array(item),
  nextCursor: z.string().optional(),
  revision: z.int(),
});

export const STATS_METHODS = {
  /** The Session's totals: requests, usage and tool calls. */
  'stats.get': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ sessionId: SessionRef }),
    result: hostResult({ stats: Stats }),
  },
  /** The Session's model requests, a page at a time. */
  'stats.requests': { primitive: 'query', plane: 'data', params: PageParams, result: page(Request) },
  /** The Session's tool calls, a page at a time. */
  'stats.tools': {
    primitive: 'query',
    plane: 'data',
    params: PageParams,
    result: page(tool(Sandbox)),
    localResult: page(tool(LocalSandbox)),
  },
} as const satisfies HostMethodRegistry;
