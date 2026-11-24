/**
 * The Host itself, managed by its owner on the same machine: what it runs, when
 * it may stop, its log, how a client leaves it, and what a person sends to
 * support. Only a role that reaches the local plane may call these, so results
 * may name paths on the Host.
 */
import { z } from 'zod/v4';

import { hostCommandParams, hostList, hostParams, hostResult, type HostMethodRegistry } from './schema.js';
import { SessionRef } from './session.js';

const IntegrationDomain = z.object({
  /** `mcp`, `a2a`, `extensions` or `host`. */
  domain: z.string(),
  /** The configuration file the Host reads for this domain. */
  path: z.string(),
  revision: z.string().optional(),
  /** `user`, `legacy-user` or `default`: where the configuration came from. */
  source: z.string().optional(),
  lastReloadAt: z.int().optional(),
  /** Why the domain is not as configured. `code` is `invalid-config`, `activation-failed` or `watcher-degraded`. */
  diagnostic: z.object({ code: z.string(), message: z.string(), at: z.int() }).optional(),
  /** Whether the Host picks up a change to the file without a restart. */
  watching: z.boolean(),
});

const HostGetResult = hostResult({
  host: z.object({
    id: z.string(),
    version: z.string(),
    mode: z.string(),
    profile: z.string(),
    startedAt: z.int(),
  }),
  /** `activeRuns` are Runs in progress that are not waiting in the queue. */
  counts: z.object({
    sessions: z.int(),
    runs: z.int(),
    activeRuns: z.int(),
    queuedRuns: z.int(),
    workflows: z.int(),
  }),
  /** `degraded` when a domain is not as configured. The Host runs either way. Absent when the Host does not watch them. */
  integrations: z.object({ state: z.string(), domains: z.array(IntegrationDomain) }).optional(),
});

const PreflightResult = hostResult({
  canStop: z.boolean(),
  /**
   * What stopping now would cut short: `connected_clients`, `active_runs`,
   * `queued_runs`, `active_workflows`, `active_agent_turns` or
   * `pending_interactions`.
   */
  blockers: z.array(z.string()),
  /** The clients connected to the Host. */
  clients: z.array(z.object({
    name: z.string().optional(),
    title: z.string().optional(),
    version: z.string().optional(),
    type: z.string(),
    connectedAt: z.int(),
  })),
  activeRunIds: z.array(z.string()),
  queuedRunIds: z.array(z.string()),
  activeWorkflowIds: z.array(z.string()),
  activeAgentTurns: z.array(z.object({ sessionId: z.string(), actorPath: z.string(), turnId: z.string(), kind: z.string() })),
  pendingInteractions: z.int(),
  /** Work an idle Host keeps for later and a stop gives up. */
  pendingBackgroundWork: z.int().optional(),
  /**
   * The Host process. After a stop, a client waits until this process is gone;
   * `processStartIdentity` tells it apart from a later process that got the same `pid`.
   */
  owner: z.object({ pid: z.int(), createdAt: z.int(), processStartIdentity: z.string().optional() }),
});

const LogResult = hostResult({
  logFile: z.string().optional(),
  /** The most recent entries, oldest first. */
  entries: z.array(z.object({
    at: z.int(),
    level: z.string(),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  })),
});

/**
 * One client's request to leave the Host, and what became of it. `id` is the
 * `requestId` the client sent.
 */
const ClientExit = z.object({
  id: z.string(),
  /** The Host the exit was asked of. */
  runtimeId: z.string(),
  requestedAt: z.int(),
  updatedAt: z.int(),
  /** The client's own work the Host stopped or withdrew. */
  cleanup: z.object({
    /** `pending`, `succeeded`, `unknown` or `failed`. */
    state: z.string(),
    runIds: z.array(z.string()),
    actorTurns: z.array(z.object({ actorPath: z.string(), turnId: z.string() })),
    withdrawnInputs: z.array(z.object({ sessionId: z.string(), inputId: z.string() })),
    operationIds: z.array(z.string()),
    issues: z.array(z.string()),
  }),
  /** Whether the client asked the Host to stop too, and how that went. */
  host: z.object({
    requested: z.boolean(),
    /** `not_requested`, `pending`, `protected`, `accepted`, `succeeded`, `failed` or `unknown`. */
    state: z.string(),
    cleanup: z.string().optional(),
    message: z.string().optional(),
    /** Another Host was already running in this one's place. */
    replacementRunning: z.boolean().optional(),
  }),
  /**
   * Whether the client may start or connect again. `state` is `ready`,
   * `pending` or `blocked`; `nextAction` says what to do about it.
   */
  recovery: z.object({ state: z.string(), reason: z.string(), nextAction: z.string(), checkedAt: z.int() }).optional(),
});

const RepoIndexResult = hostResult({
  configuredMode: z.string(),
  requestedMode: z.string(),
  effectiveEngine: z.string(),
  /** `disabled`, `ok`, `limited`, `unavailable` or `warming`. */
  status: z.string(),
  initialized: z.boolean(),
  warnings: z.array(z.string()),
  /** The directory the Session's code index covers. */
  workspaceRoot: z.string(),
});

export const HOST_ADMIN_METHODS = {
  /** Which Host this is, its version, and how much work it holds. */
  'host.get': { primitive: 'query', plane: 'local', params: hostParams({}), result: HostGetResult },
  /** Whether the Host can stop now, and what stopping would cut short. */
  'host.preflight': { primitive: 'query', plane: 'local', params: hostParams({}), result: PreflightResult },
  /**
   * Fails with `conflict` while stopping would cut work short; `host.preflight`
   * says what. The SDK does not send it again: that would stop the Host that
   * replaced the one it stopped.
   */
  'host.stop': { primitive: 'command', resend: 'never', plane: 'local', params: hostCommandParams({}), result: hostResult({}) },
  /** The Host's most recent log entries. */
  'host.logs': { primitive: 'query', plane: 'local', params: hostParams({}), result: LogResult },
  /**
   * Stops this client's work on the Host, and the Host too with `shutdownHost`
   * when no other client is connected. Sending the same `requestId` again
   * answers with the same exit.
   */
  'client.exit.request': {
    primitive: 'command',
    // A lost link most likely means it did what it asked; the client does not come back to ask again.
    resend: 'never',
    plane: 'local',
    params: hostCommandParams({ shutdownHost: z.boolean().optional() }),
    result: hostResult({ exit: ClientExit }),
  },
  /** An exit this client asked for with `client.exit`, and how far it got. */
  'client.exit.get': {
    primitive: 'query',
    plane: 'local',
    /** The `requestId` the exit was asked with, which is its `id`. */
    params: hostParams({ exitId: z.string().min(1).max(128) }),
    result: hostResult({ exit: ClientExit }),
  },
  /** This client's exits that are not yet done. */
  'client.exit.list': { primitive: 'query', plane: 'local', params: hostParams({}), result: hostList(ClientExit) },
  /**
   * A record of the Session and its Run for a support request. Its shape is
   * versioned by `schemaVersion` and sent as the Host wrote it; read it, do not
   * branch on it.
   */
  'session.diagnostics': {
    primitive: 'query',
    plane: 'local',
    params: hostParams({ sessionId: SessionRef, runId: z.string().min(1).max(256).optional() }),
    result: hostResult({ diagnostics: z.record(z.string(), z.unknown()) }),
  },
  /** Reading the state never builds the index. */
  'repo.intelligence.inspect': {
    primitive: 'query', plane: 'local', params: hostParams({ sessionId: SessionRef }), result: RepoIndexResult,
  },
  /** Builds the Session's code index now, so its first Run does not wait for it. */
  'repo.intelligence.prewarm': {
    primitive: 'command', resend: 'auto', plane: 'local', params: hostCommandParams({ sessionId: SessionRef }), result: RepoIndexResult,
  },
} as const satisfies HostMethodRegistry;

/** What the Host sends on its own to every connection. A client never calls it, so it is not in the method table. */
export const HOST_NOTIFICATIONS = {
  /**
   * The Host is stopping. It stops the Runs, their ends still arrive, and then
   * the connection closes as `unavailable`. Start nothing new; reconnect after
   * backing off, possibly to the Host that replaces this one.
   */
  'host.draining': { params: z.object({ _meta: z.record(z.string(), z.unknown()).optional() }) },
} as const;
