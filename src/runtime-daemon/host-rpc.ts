/**
 * Serves the v2 protocol on the local IPC endpoint and on the network listener.
 * A v2 connection is admitted through the same dispatcher a v1 connection uses,
 * so both protocols share one set of access, admission and lifecycle rules
 * while methods move over.
 */
import { isDeepStrictEqual } from 'node:util';

import {
  emitKodaXDiagnostic, type AgentActor, type AgentDetail, type AgentEvent, type AgentFollowupResult, type AgentMailboxMessage,
  type AgentOutput, type AgentProgressItem, type AgentTreeSnapshot, type AgentTurn, type AgentTurnRef,
  type LearnedCapabilityRecord, type LearningEvent,
  type LearningPage,
} from '@kodax-ai/agent';

import type { HostCloseReason } from '../host-protocol/close.js';
import type { HostIncident } from '../host-protocol/connection.js';
import { HostProtocolError, hostRpcNotification, type HostErrorCode } from '../host-protocol/codec.js';
import type { HostInitializeParams, HostLimits, HostMethodName, HostParams } from '../host-protocol/methods.js';
import type {
  ClientCommandResult, ClientExecutionFactsPage, ClientExitReceipt, ClientHistoryTurnResolution, ClientHistoryTurnSelector,
  ClientHistoryTurnTarget, ClientInputAcceptance, ClientInteraction, ClientInteractionResult, ClientItemContent,
  ClientLineageEntry, ClientLineageSummary, ClientProviderRequestFact, ClientSessionGoal, ClientStatisticsService,
  ClientSubmitInput, ClientToolExecutionFact,
} from '@kodax-ai/coding/client-contract';

import type { McpServerStatus, McpServerToolList } from '@kodax-ai/coding';
import type {
  RuntimeCommandInfo, RuntimeCompactSessionResult, RuntimeConfigReloadResult, RuntimeDaemonManagementState, RuntimeEffectiveConfigSnapshot, RuntimeExtensionListResult, RuntimeIdentity, RuntimeIntegrationHealth, RuntimeStatusSnapshot,
  RuntimeConversationHistoryEntryChunk, RuntimeConversationHistorySlice, RuntimePermissionGrant, RuntimeRunAnswer, RuntimeRunStatus,
  RuntimeSession, RuntimeSessionPromotionResult, RuntimeSessionSettings, RuntimeSessionStatus, RuntimeSessionSummary, RuntimeTranscriptSearchResult,
  RuntimeMcpValidateResult, RuntimeVersionedValue, RuntimeWorkflowSnapshot, RuntimeWorkflowStartResult, RuntimeWorkflowSummary,
} from '../sdk-runtime.js';
import type {
  RuntimeCredentialLease, RuntimeHostToolInvocationStatus, RuntimeHostToolLease,
} from '../client-host-authorization.js';
import type { HostDeviceRegistry } from '../host-server/devices.js';
import type { HostBlobStore } from './host-blobs.js';
import { boundViewItem } from '../session-view.js';
import { runtimeAuthorizationSubject, runtimeRoleHasPlane, type RuntimeConnectionRole } from './access.js';
import {
  createHostViewStreams, parseAttachmentBlobId, toInteraction, toSessionResource, toViewItem, toWorkflow, utcMilliseconds,
  type HostViewStreams,
} from './host-view.js';
import {
  createRuntimeDaemonRequest,
  type RuntimeDaemonError,
  type RuntimeDaemonErrorCode,
  type RuntimeDaemonMethod,
  type RuntimeDaemonNotification,
} from './protocol.js';
import { createRuntimeDaemonDispatcher, type RuntimeDaemonDispatcherOptions } from './server.js';
import { runtimeConfigRevision } from '../runtime-config-revision.js';
import { reportHostSecurityEvent } from './security-log.js';
import type { RuntimeDaemonLogEntry } from './state.js';
import type { RuntimeDaemonFramePeer } from './transport.js';
import type { HostWorkspace } from './workspace.js';

/** What a v2 client should do about each v1 failure. The v1 code travels on as the `reason`. */
const V1_ERROR_CODES: Readonly<Record<RuntimeDaemonErrorCode, HostErrorCode>> = {
  invalid_frame: 'invalid_params',
  invalid_request: 'invalid_params',
  invalid_params: 'invalid_params',
  not_initialized: 'invalid_state',
  method_not_found: 'method_not_found',
  client_upgrade_required: 'method_not_found',
  unauthorized: 'unauthorized',
  permission_denied: 'forbidden',
  execution_binding_rejected: 'forbidden',
  not_found: 'not_found',
  host_tool_unknown: 'not_found',
  default_skill_unavailable: 'not_found',
  conflict: 'conflict',
  execution_binding_changed: 'conflict',
  execution_mode_mismatch: 'conflict',
  session_not_admitted: 'invalid_state',
  resync_required: 'resync_required',
  data_changed: 'resync_required',
  observation_invalidated: 'resync_required',
  runtime_changed: 'resync_required',
  overloaded: 'overloaded',
  credential_unavailable: 'unavailable',
  host_tool_unavailable: 'unavailable',
  execution_binding_unavailable: 'unavailable',
  read_timeout: 'timeout',
  cancelled: 'cancelled',
  read_cancelled: 'cancelled',
  data_corrupt: 'internal',
  version_incompatible: 'internal',
  internal_error: 'internal',
};

/**
 * Calls the v1 implementation as this connection. Cancelling the v2 request
 * cancels the call; a handler that gives up sooner passes its own `signal`.
 */
type V1Call = (
  method: RuntimeDaemonMethod,
  params?: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => Promise<unknown>;

type DeviceMethod = 'device.pair' | 'device.list' | 'device.revoke';
type ForwardedMethod = Exclude<HostMethodName, 'initialize' | 'ping' | 'request.cancel' | 'auth.renew' | DeviceMethod>;

/** What the owner manages of the paired devices. */
export type HostDeviceAdmin = Pick<HostDeviceRegistry, 'pair' | 'list' | 'revoke'>;

/** The paired devices belong to the network listener, not to v1, so the peer serves them itself. */
const DEVICE_HANDLERS: { readonly [Method in DeviceMethod]: (params: HostParams<Method>, devices: HostDeviceAdmin) => unknown } = {
  'device.pair': ({ requestId, name }, devices) => devices.pair({ requestId, name }),
  'device.list': (_params, devices) => ({ items: devices.list() }),
  'device.revoke': ({ deviceId }, devices) => {
    devices.revoke(deviceId);
    return {};
  },
};

/** What a handler knows about the connection it serves. */
interface HostCaller {
  /** Who the connection acts for. A `requestId` means one intent of this subject. */
  readonly subject: string;
  /** Whether the connection is on the Host's own machine, so it may name Host paths. */
  readonly local: boolean;
  /** Whether the connection is an application's backend and not a person at a client. */
  readonly service: boolean;
  readonly workspace?: HostWorkspace;
  readonly blobs?: HostBlobStore;
  readonly views: HostViewStreams;
  /** Aborted when the client cancels this call or the connection ends. */
  readonly signal: AbortSignal;
  /** Runs once the answer to this call is on the wire. */
  readonly afterAnswer: (run: () => void) => void;
}

/** Answers with what v1 returned. The connection cuts it to the v2 contract, so a handler only reshapes. */
type V1Handler<Method extends ForwardedMethod> = (
  params: HostParams<Method>,
  v1: V1Call,
  caller: HostCaller,
) => Promise<unknown>;

/**
 * How the v1 implementation serves each v2 method. The mapped type makes a new
 * method a compile error until it is served. The connection itself answers
 * `initialize`, `ping` and `request.cancel`; the peer answers `auth.renew` from
 * the credential it admitted.
 */
const V1_HANDLERS: { readonly [Method in ForwardedMethod]: V1Handler<Method> } = {
  'lease.register': async (params, v1) => (
    { lease: params.kind === 'credential' ? await registerCredential(params, v1) : await registerHostTools(params, v1) }
  ),
  'lease.resume': async ({ kind, leaseId }, v1) => {
    const held = kind === 'credential' ? await heldLease(v1, leaseId) : await heldHostTools(v1, leaseId);
    if (held === undefined) throw leaseNotFound();
    return { lease: 'providers' in held ? toLease(held) : toToolLease(held) };
  },
  'lease.revoke': async ({ kind, leaseId }, v1) => {
    await v1(kind === 'credential' ? 'credential.revoke' : 'host_tool.revoke', { leaseId });
    return {};
  },
  'lease.complete': async (params, v1) => {
    const answer = params.kind === 'credential' ? params.credential : params.result;
    if ((answer === undefined) === (params.error === undefined)) {
      throw new HostProtocolError('invalid_params', 'An answer carries the error or what was asked for, and not both.', {
        reason: 'answer_required',
      });
    }
    const { ok } = await (params.kind === 'credential'
      ? v1('credential.supply', defined({ requestId: params.callId, credential: params.credential, error: params.error }))
      : v1('host_tool.complete', defined({ invocationId: params.callId, result: params.result, error: params.error }))) as
      { readonly ok: boolean };
    return { status: ok ? 'accepted' : 'already_settled' };
  },
  'lease.call.get': async ({ callId }, v1) => {
    const call = await v1('host_tool.invocation.get', { invocationId: callId }) as RuntimeHostToolInvocationStatus | null | undefined;
    if (call == null) {
      throw new HostProtocolError('not_found', 'This client instance has no such tool call.', { reason: 'call_not_found' });
    }
    return { call: {
      callId: call.invocationId, leaseId: call.leaseId, tool: call.toolName, sessionId: call.sessionId, runId: call.runId,
      state: CALL_STATES[call.state], updatedAt: utcMilliseconds(call.updatedAt),
    } };
  },

  'provider.list': async (_params, v1) => ({ items: await v1('provider.list') }),
  'provider.reasoning.efforts': async ({ provider, model }, v1) => (
    { items: await v1('provider.reasoning.efforts', defined({ provider, model })) }
  ),
  'command.list': async ({ project, projectRoot }, v1, caller) => {
    const commands = await v1('command.list', defined({ projectRoot: await catalogProject(caller, project, projectRoot) })) as readonly RuntimeCommandInfo[];
    return { items: commands.filter(runsThroughHost) };
  },
  'command.readPrompt': async ({ sessionId, name, args }, v1) => (
    { prompt: await v1('invocations.readCommandPrompt', defined({ sessionId, name, args })) ?? undefined }
  ),
  'skill.list': async ({ project, projectRoot }, v1, caller) => (
    { items: await v1('skill.list', defined({ projectRoot: await catalogProject(caller, project, projectRoot) })) }
  ),
  'skill.get': async ({ name, project, projectRoot }, v1, caller) => ({
    skill: await v1('skill.describe', defined({ name, projectRoot: await catalogProject(caller, project, projectRoot) }))
      ?? undefined,
  }),
  'tool.list': async ({ sessionId }, v1) => ({ items: await v1('tool.catalog', { sessionId }) }),
  'agent.list': async (_params, v1) => ({ items: await v1('agent.list') }),

  'session.list': async ({ project, projectRoot, limit = 50, _meta, ...filter }, v1, caller) => {
    const directory = await namedProject(caller, project, projectRoot);
    // One more than asked for tells whether another page follows.
    const found = await v1('session.list', defined({ ...filter, projectRoot: directory, limit: limit + 1 })) as
      readonly RuntimeSessionSummary[];
    const page = found.slice(0, limit);
    return {
      items: await Promise.all(page.map(session => toSession(session, caller))),
      nextCursor: found.length > limit ? page.at(-1)?.cursor : undefined,
    };
  },
  'session.get': async ({ sessionId }, v1, caller) => {
    const [session, status] = await Promise.all([
      v1('session.load', { sessionId }) as Promise<RuntimeSession>,
      v1('session.status', { sessionId }) as Promise<RuntimeSessionStatus>,
    ]);
    return { session: await toSession(session, caller), phase: status.phase, runId: status.runId };
  },
  'session.create': async ({ requestId, project, projectRoot, policy, _meta, ...facts }, v1, caller) => {
    const projectPath = await namedProject(caller, project, projectRoot) ?? await defaultProject(caller);
    const session = await v1('session.create', defined({
      ...facts, projectPath, requestId: `${caller.subject}:${requestId}`,
      // Nobody is assumed to be watching a Session a backend creates, so its Runs do not wait for a person unless it says so.
      policy: caller.service ? { interactions: 'reject', ...policy } : policy,
    })) as RuntimeSession;
    return { session: await toSession(session, caller) };
  },
  'session.policy.get': async ({ sessionId }, v1) => (
    { policy: toPolicy((await v1('session.load', { sessionId }) as RuntimeSession).policy) }
  ),
  'session.policy.update': async ({ sessionId, policy }, v1, caller) => {
    const session = await v1('session.policy.update', {
      sessionId, policy: caller.service ? { interactions: 'reject', ...policy } : policy,
    }) as RuntimeSession;
    return { policy: toPolicy(session.policy) };
  },
  'session.archive': async ({ sessionId }, v1) => {
    await v1('session.archive', { sessionId });
    return {};
  },
  'session.unarchive': async ({ sessionId }, v1) => {
    await v1('session.unarchive', { sessionId });
    return {};
  },
  'session.delete': async ({ sessionId }, v1) => {
    try {
      await v1('session.delete', { sessionId });
    } catch (error: unknown) {
      // A repeat of a delete that worked finds nothing left, which is what it asked for.
      if (!(error instanceof HostProtocolError) || error.kodaxCode !== 'not_found') throw error;
    }
    return {};
  },
  // The requestId is not prefixed with the caller: a Session is promoted once, and whoever reaches it may read the result.
  'session.promote': async ({ requestId, sessionId, ifRevision, tag }, v1, caller) => {
    const { session } = await v1('session.promote', { sessionId, requestId, expectedRevision: ifRevision, tag }) as
      RuntimeSessionPromotionResult;
    return { session: await toSession(session, caller) };
  },
  'session.promotion.get': async ({ sessionId, promotionId }, v1, caller) => {
    const promoted = await v1('session.promotion.read', { sessionId, requestId: promotionId }) as RuntimeSessionPromotionResult | null;
    if (promoted === null) {
      throw new HostProtocolError('not_found', 'That request did not promote the Session.', { reason: 'promotion_not_found' });
    }
    return { session: await toSession(promoted.session, caller) };
  },
  'session.compact': async ({ requestId, sessionId, instructions, leases }, v1, caller) => {
    const result = await v1('session.compact', defined({
      sessionId, customInstructions: instructions, requestId: `${caller.subject}:${requestId}`,
      credential: await credentialBinding(v1, leases),
    })) as RuntimeCompactSessionResult;
    if (result.failed === true) {
      throw new HostProtocolError('unavailable', result.reason ?? 'The conversation could not be summarised.', {
        reason: 'compaction_failed',
      });
    }
    return result;
  },

  'session.lineage.get': async ({ sessionId, limit = 200, cursor }, v1) => {
    const tree = await v1('session.lineage.get', { sessionId }) as ClientLineageSummary | null;
    const entries = tree?.entries ?? [];
    const start = cursor === undefined ? 0 : entries.findIndex(entry => entry.id === cursor) + 1;
    if (cursor !== undefined && start === 0) {
      throw new HostProtocolError('resync_required', 'The entry this page follows is gone. Read the tree again from the start.', {
        reason: 'cursor_gone',
      });
    }
    const page = entries.slice(start, start + limit);
    return defined({
      items: page.map(toTreeEntry),
      nextCursor: start + limit < entries.length ? page.at(-1)?.id : undefined,
      activeEntryId: tree?.activeEntryId ?? undefined,
    });
  },
  'session.lineage.label': async ({ sessionId, entry, label }, v1) => {
    const before = await v1('session.lineage.get', { sessionId }) as ClientLineageSummary | null;
    const recorded = before === null ? undefined : newestLabelRecord(before.entries, entry);
    // Sent again after it worked: the entry already carries what was asked, so nothing more is recorded.
    if (recorded !== undefined && recorded.label === label?.trim()) return { entry: toTreeEntry(recorded) };
    const tree = await v1('session.lineage.label', defined({ sessionId, selector: entry, label })) as ClientLineageSummary;
    // v1 answers with the whole tree. The entry that records the label is its newest.
    return { entry: toTreeEntry(tree.entries.at(-1)!) };
  },
  'session.branch.select': async ({ sessionId, entry, summarize, ifActiveEntryId }, v1, caller) => ({
    session: await toSession(await v1('session.activeEntry.set', defined({
      sessionId, entryId: entry, summarizeCurrentBranch: summarize, expectedHead: ifActiveEntryId,
    })) as RuntimeSession, caller),
  }),
  'session.notice.append': async ({ requestId, sessionId, text, source }, v1, caller) => {
    const notice = await v1('session.notice.append', defined({
      sessionId, content: text, source, requestId: `${caller.subject}:${requestId}`,
    })) as { readonly entryId: string } | null;
    // v1 answers `null` when the notice did not reach the Session's file.
    if (notice === null) {
      throw new HostProtocolError('unavailable', 'The notice could not be saved.', { reason: 'notice_not_saved' });
    }
    return { itemId: notice.entryId };
  },

  'session.fork': async ({ requestId, sessionId, turn, before, entry, title }, v1, caller) => {
    const fork = await v1('session.fork', defined({
      sessionId, before, title, selector: entry, requestId: `${caller.subject}:${requestId}`,
      turn: turn === undefined ? undefined : turnTarget(sessionId, turn),
    })) as RuntimeSession | null;
    // v1 answers `null` when the turn is no longer where the conversation says it ends.
    if (fork === null) throw turnGone();
    return { session: await toSession(fork, caller) };
  },
  'session.recover': async ({ requestId, sessionId, title, reason }, v1, caller) => ({
    session: await toSession(await v1('session.recover', defined({
      sessionId, title, reason, requestId: `${caller.subject}:${requestId}`,
    })) as RuntimeSession, caller),
  }),
  'session.rewind': async ({ sessionId, turn, entry, ifActiveEntryId }, v1, caller) => {
    // A rewind without a place to go back to would go back further each time it is sent again, so v2 has none.
    if ((turn === undefined) === (entry === undefined)) {
      throw new HostProtocolError('invalid_params', 'Send the turn or the entry to go back to, and only one of them.');
    }
    if ((entry === undefined) !== (ifActiveEntryId === undefined)) {
      throw new HostProtocolError('invalid_params', 'An entry is sent with ifActiveEntryId, and a turn without it.');
    }
    const target = turn === undefined ? undefined : turnTarget(sessionId, turn);
    const tree = await v1('session.lineage.get', { sessionId }) as ClientLineageSummary | null;
    // The conversation already ends there: this is a repeat, or there was nothing to take back.
    if (tree?.activeEntryId != null && tree.activeEntryId === (target?.historyBoundary.entryId ?? entry)) {
      return { session: await toSession(await v1('session.load', { sessionId }) as RuntimeSession, caller) };
    }
    const session = await v1('session.rewind', defined({
      sessionId, contractVersion: 2, turn: target, selector: entry, expectedHead: ifActiveEntryId,
    })) as RuntimeSession | null;
    if (session === null) {
      if (target !== undefined) throw turnGone();
      throw new HostProtocolError('conflict', 'No entry of the tree matches.', { reason: 'entry_not_found' });
    }
    return { session: await toSession(session, caller) };
  },
  'session.side.open': async ({ sessionId }, v1, caller) => (
    // v1 keeps one side chat for each branch and each requester, so it needs no `requestId` to answer a repeat.
    { session: await toSession(await v1('session.side.open', { sessionId }) as RuntimeSession, caller) }
  ),

  'stats.get': async ({ sessionId }, v1) => {
    const { contexts, ...stats } = await v1('session.facts.read', { sessionId }) as
      Awaited<ReturnType<ClientStatisticsService['read']>>;
    return {
      stats: {
        ...stats,
        contexts: contexts.map(({ createdAt, ...context }) => ({ ...context, createdAt: utcMilliseconds(createdAt) })),
      },
    };
  },
  'stats.requests': async ({ sessionId, limit, cursor }, v1) => {
    const page = await v1('session.facts.requests', defined({ sessionId, limit, cursor })) as
      ClientExecutionFactsPage<ClientProviderRequestFact>;
    return { ...page, items: page.items.map(toRequestStats) };
  },
  'stats.tools': async ({ sessionId, limit, cursor }, v1) => {
    const page = await v1('session.facts.tools', defined({ sessionId, limit, cursor })) as
      ClientExecutionFactsPage<ClientToolExecutionFact>;
    return { ...page, items: page.items.map(({ updatedAt, ...tool }) => ({ ...tool, updatedAt: utcMilliseconds(updatedAt) })) };
  },

  'actor.tree': async ({ sessionId }, v1) => {
    const { actors, rootPath: _root, admissionRevision: _admission, ...tree } = await v1('agents.tree', { sessionId }) as AgentTreeSnapshot;
    return {
      ...tree,
      items: actors.map(({ latestTurn, ...actor }) => ({
        ...toActor(actor),
        latestTurn: latestTurn && { ...latestTurn, recentActivity: latestTurn.recentActivity.map(toProgress) },
      })),
    };
  },
  'actor.get': async ({ sessionId, actorPath }, v1) => {
    const { actor, turns, mailbox } = await v1('agents.detail', { sessionId, actorPath }) as AgentDetail;
    return { actor: toActor(actor), turns: turns.map(toTurn), mailbox: mailbox.map(toMessage) };
  },
  'actor.output': async ({ sessionId, actorPath, turnId }, v1) => {
    const output = await v1('agents.output', defined({ sessionId, actorPath, turnId })) as AgentOutput;
    return { ...output, progress: output.progress.map(toProgress) };
  },
  'actor.wait': async ({ sessionId, afterSequence, timeoutMs = RUN_WAIT_MS }, v1, caller) => {
    const event = await v1('agents.wait', defined({ sessionId, afterSequence, timeoutMs })) as AgentEvent | null | undefined;
    // v1 answers empty when the wait is given up, the same as when nothing happened.
    if (caller.signal.aborted) throw new HostProtocolError('cancelled', 'The request was cancelled.');
    if (!event) return {};
    return { event: { ...event, createdAt: utcMilliseconds(event.createdAt), progress: event.progress && toProgress(event.progress) } };
  },
  'actor.send': async ({ requestId, sessionId, actorPath, text, classification }, v1, caller) => {
    // The actor keeps the request's name with the message, so a repeat finds the delivery it made.
    await v1('agents.send', defined({
      sessionId, actorPath, content: text, classification, requestId: `${caller.subject}:${requestId}`,
    }));
    return {};
  },
  'actor.spawn': async ({ requestId, sessionId, taskName, objective, forkTurns, capabilities, leases }, v1, caller) => {
    // The turn keeps the request's name, so a repeat finds the child the first one started.
    const { actorPath, turnId } = await v1('agents.spawn', defined({
      sessionId, input: defined({ taskName, objective, forkTurns, capabilities }),
      requestId: `${caller.subject}:${requestId}`, authorization: await leaseAuthorization(v1, leases),
    })) as AgentTurnRef;
    return { actorPath, turnId };
  },
  'actor.followup': async ({ requestId, sessionId, actorPath, objective, ifRevision, leases }, v1, caller) => {
    const { delivery, turn } = await v1('agents.followup', defined({
      sessionId, actorPath, objective, expectedRevision: ifRevision,
      requestId: `${caller.subject}:${requestId}`, authorization: await leaseAuthorization(v1, leases),
    })) as AgentFollowupResult;
    return { delivery, turnId: turn.turnId };
  },
  'actor.interrupt': async ({ sessionId, actorPath, turnId, reason }, v1) => {
    // Naming the turn makes a repeat harmless: once that turn ended, the actor is left as it is.
    await v1('agents.interrupt', defined({ sessionId, actorPath, turnId, reason }));
    return {};
  },

  'workflow.list': async ({ sessionId, activeOnly, limit = 50, cursor }, v1) => {
    const workflows = [...await v1('workflow.list', defined({ sessionId, activeOnly })) as readonly RuntimeWorkflowSummary[]]
      .sort((left, right) => right.startedAt - left.startedAt);
    const from = cursor === undefined ? 0 : workflows.findIndex(workflow => workflow.runId === cursor) + 1;
    if (cursor !== undefined && from === 0) {
      throw new HostProtocolError('resync_required', 'cursor names no workflow of this Session.', { reason: 'cursor_expired' });
    }
    const page = workflows.slice(from, from + limit);
    return { items: page.map(toWorkflow), nextCursor: from + limit < workflows.length ? page.at(-1)?.runId : undefined };
  },
  'workflow.get': async ({ sessionId, workflowId }, v1) => ({ workflow: await sessionWorkflow(v1, sessionId, workflowId) }),
  'workflow.start': async ({ requestId, sessionId, name, request, script, args, provider, model, leases }, v1) => {
    const source = workflowSource(name, request, script);
    const session = await v1('session.load', { sessionId }) as RuntimeSession;
    const projectRoot = session.workspaceRoot ?? session.gitRoot;
    if (projectRoot === undefined) {
      throw new HostProtocolError('invalid_state', 'The Session works in no project, so a workflow has nowhere to run.', {
        reason: 'session_without_project',
      });
    }
    // The request names the start as an input of the Session, so a repeat finds the Run the first one began.
    const started = await v1('workflow.start', defined({
      sessionId, inputId: requestId, projectRoot, source, args, provider, model, settingsDefaults: 'product',
      authorization: await leaseAuthorization(v1, leases),
    })) as RuntimeWorkflowStartResult;
    if (started.kind === 'declined') {
      throw new HostProtocolError('invalid_params', started.reason, { reason: 'workflow_declined' });
    }
    return { workflowId: started.runId, runId: started.runId };
  },
  'workflow.pause': async ({ sessionId, workflowId }, v1) => {
    await sessionWorkflow(v1, sessionId, workflowId);
    if (await v1('workflow.pause', { runId: workflowId }) !== true) await settledAs(v1, sessionId, workflowId, 'paused');
    return {};
  },
  'workflow.resume': async ({ sessionId, workflowId }, v1) => {
    await sessionWorkflow(v1, sessionId, workflowId);
    if (await v1('workflow.resume', { runId: workflowId }) !== true) await settledAs(v1, sessionId, workflowId, 'running');
    return {};
  },
  'workflow.stop': async ({ sessionId, workflowId }, v1) => {
    await sessionWorkflow(v1, sessionId, workflowId);
    // v1 answers false for a workflow that ended or was already asked to stop: either way there is nothing more to do.
    await v1('workflow.stop', { runId: workflowId, sessionId });
    return {};
  },

  'session.goal.get': async ({ sessionId }, v1) => toGoalAnswer(await v1('session.goal.get', { sessionId })),
  'session.goal.create': async ({ sessionId, objective, tokenBudget }, v1) => holdsAlready(
    v1('session.goal.create', defined({ sessionId, objective, tokenBudget })).then(toGoalAnswer), v1, sessionId,
    goal => goal !== null && goal.status !== 'complete'
      && goal.objective === objective.trim() && goal.tokenBudget === (tokenBudget ?? null),
  ),
  'session.goal.pause': async ({ sessionId }, v1) => holdsAlready(
    v1('session.goal.pause', { sessionId }).then(toGoalAnswer), v1, sessionId, goal => goal?.status === 'paused',
  ),
  'session.goal.resume': async ({ sessionId }, v1) => holdsAlready(
    v1('session.goal.resume', { sessionId }).then(toGoalAnswer), v1, sessionId, goal => goal?.status === 'active',
  ),
  'session.goal.clear': async ({ sessionId }, v1) => holdsAlready(
    v1('session.goal.clear', { sessionId }).then(() => ({})), v1, sessionId, goal => goal === null,
  ),

  'session.settings.get': async ({ sessionId }, v1) => (
    toSettingsState(await v1('session.settings.getVersioned', { sessionId }) as VersionedSettings)
  ),
  'session.settings.update': async ({ sessionId, patch, ifRevision }, v1) => {
    if (ifRevision !== undefined) {
      return toSettingsState(await v1('session.settings.updateVersioned', {
        sessionId, patch, expectedRevision: revisionNumber(ifRevision),
      }) as VersionedSettings);
    }
    await v1('session.settings.update', { sessionId, patch });
    return toSettingsState(await v1('session.settings.getVersioned', { sessionId }) as VersionedSettings);
  },

  'view.subscribe': async ({ subscriptionId, target }, v1, caller) => {
    const subscription = await caller.views.subscribe(subscriptionId, target.sessionId, v1);
    caller.afterAnswer(subscription.answered);
    return subscription.answer;
  },
  'view.unsubscribe': async ({ subscriptionId }, _v1, caller) => {
    await caller.views.unsubscribe(subscriptionId);
    return {};
  },
  'item.read': async ({ sessionId, itemId, part = 'text', cursor }, v1) => {
    const from = cursor === undefined ? undefined : readItemCursor(cursor);
    const content = await v1('session.view.item', defined({
      sessionId, itemId, part: part === 'output' ? 'original' : part, offset: from?.offset,
    })) as ClientItemContent | null;
    if (content === null) {
      throw new HostProtocolError('not_found', 'The Session has no such item.', { reason: 'item_not_found' });
    }
    const revision = content.textRevision ?? 0;
    if (from !== undefined && from.revision !== revision) {
      throw new HostProtocolError('resync_required', 'The item was rewritten; read it again from the start.', {
        reason: 'item_changed',
      });
    }
    return {
      text: content.text,
      total: content.totalLength,
      nextCursor: content.nextOffset !== undefined ? `${content.nextOffset}.${revision}` : undefined,
    };
  },

  'history.read': async ({ sessionId, limit, cursor, around }, v1) => {
    const { projectConversationHistoryPage, readHistoryPageWithBoundaryRetry } = await import('../client-history.js');
    const saved = await readHistoryPageWithBoundaryRetry(
      () => v1('session.conversation.page', defined({
        sessionId, limit, cursor, around: around === undefined ? undefined : { searchItemId: around.itemId },
      })) as Promise<RuntimeConversationHistorySlice | null>,
      { cursor, around },
      error => error instanceof HostProtocolError && error.kodaxCode === 'resync_required',
    );
    if (saved === null) {
      throw new HostProtocolError('not_found', 'The Session has no saved conversation.', { reason: 'history_not_found' });
    }
    // Long items are cut the way a view cuts them, so one item reads the same in both.
    const page = await projectConversationHistoryPage(
      sessionId, saved,
      chunk => v1('session.conversation.entryChunk', { ...chunk }) as Promise<RuntimeConversationHistoryEntryChunk | null>,
      emitKodaXDiagnostic, boundViewItem,
    );
    // A message keeps the id the view shows it under, however the conversation is saved later.
    const { stableHistoryItemIds } = await import('../session-view.js');
    const ids = stableHistoryItemIds(sessionId, page.items);
    const located = page.locatedBoundaryId === undefined ? -1
      : page.items.findIndex(item => item.historyBoundary?.entryId === page.locatedBoundaryId);
    return {
      items: page.items.map((item, index) => toViewItem({ ...item, id: ids[index]! })),
      status: page.status,
      issues: page.issues,
      nextCursor: page.nextCursor,
      newerCursor: page.newerCursor,
      locatedItemId: located < 0 ? undefined : ids[located],
    };
  },
  'history.resolveTurn': async ({ sessionId, turn = { kind: 'latest' } }, v1) => {
    const selector = turn.kind === 'item' ? await itemTurnSelector(sessionId, turn.itemId) : turn;
    const found = await v1('session.history.resolveTurn', { sessionId, contractVersion: 2, selector }) as
      ClientHistoryTurnResolution;
    if (found.status !== 'ready') return { unavailable: found.reason };
    return {
      turn: { ref: turnRef(found), index: found.turnIndex, excerpt: found.excerpt, hasLaterTurn: found.hasLaterTurn },
    };
  },
  'history.search': async ({ sessionId, query, limit, role }, v1) => {
    // v1 searches only what was summarised away unless it is told otherwise.
    const found = await v1('session.transcript.search', defined({ sessionId, query, limit, role, scope: 'all' })) as
      RuntimeTranscriptSearchResult | null;
    if (found === null) {
      throw new HostProtocolError('resync_required', 'The conversation changed during the search; search again.', {
        reason: 'search_boundary_lost',
      });
    }
    const { transcriptEntryItemId } = await import('../client-history.js');
    return {
      items: found.hits.map(hit => ({
        itemId: transcriptEntryItemId(sessionId, found.revision, hit.entryIndex),
        role: hit.role === 'user' ? 'user' : 'assistant',
        at: utcMilliseconds(hit.timestamp),
        snippet: hit.snippet,
      })),
    };
  },

  'input.submit': async ({
    requestId, sessionId, text, delivery, targetRunId, localAttachments, attachments, budget, prompt, leases,
  }, v1, caller) => {
    if ((delivery === 'steer' || delivery === 'redirect') && targetRunId === undefined) {
      throw new HostProtocolError('invalid_params', 'A steer or redirect input names the Run it acts on.', {
        reason: 'target_run_required',
      });
    }
    const runOptions = budget === undefined && prompt === undefined ? undefined : defined({ budget, prompt });
    if (runOptions !== undefined && delivery === 'steer') {
      throw new HostProtocolError('invalid_params', 'A steer input joins a Run that is already working, so it takes no budget or prompt.', {
        reason: 'run_options_not_allowed',
      });
    }
    const uploaded = attachments === undefined ? []
      : await Promise.all(attachments.map(attachment => uploadedImage(requireBlobs(caller), sessionId, attachment)));
    const inputArtifacts = [...localAttachments ?? [], ...uploaded];
    // The input's id is the requestId: v1 already starts one Run per input id and refuses another intent under it.
    const accepted = await v1('input.submit', defined({
      sessionId, inputId: requestId, text, delivery, targetRunId, runOptions,
      inputArtifacts: inputArtifacts.length > 0 ? inputArtifacts : undefined,
      authorization: await leaseAuthorization(v1, leases),
    })) as ClientInputAcceptance;
    return { input: toInput(accepted) };
  },
  'input.get': async ({ sessionId, inputId }, v1) => {
    const accepted = await v1('input.read', { sessionId, inputId }) as ClientInputAcceptance | null;
    if (accepted === null) {
      throw new HostProtocolError('not_found', 'The Session accepted no such input.', { reason: 'input_not_found' });
    }
    return { input: toInput(accepted) };
  },
  'input.withdraw': async ({ sessionId, inputId }, v1, caller) => {
    const { inputArtifacts, ...input } = await v1('input.withdraw', { sessionId, inputId }) as ClientSubmitInput;
    // Attachments are Host paths, uploaded images among them; a client elsewhere gets none.
    return { input: { ...input, id: input.inputId, localAttachments: caller.local ? inputArtifacts : undefined } };
  },

  'blob.begin': async ({ sessionId, mediaType, byteLength, sha256 }, v1, caller) => {
    const blobs = requireBlobs(caller);
    if (await v1('session.load', { sessionId }) === null) {
      throw new HostProtocolError('not_found', 'The Host has no such Session.', { reason: 'session_not_found' });
    }
    return blobs.begin(sessionId, { mediaType, byteLength, sha256 });
  },
  'blob.write': async ({ sessionId, blobId, offset, data }, _v1, caller) =>
    requireBlobs(caller).write(sessionId, blobId, offset, Buffer.from(data, 'base64')),
  'blob.commit': async ({ sessionId, blobId }, _v1, caller) => ({ blob: await requireBlobs(caller).commit(sessionId, blobId) }),
  'blob.read': async ({ sessionId, blobId, cursor }, v1, caller) => {
    const from = cursor === undefined ? undefined : readBlobCursor(cursor);
    const offset = from?.offset ?? 0;
    const attachment = parseAttachmentBlobId(blobId);
    const chunk = attachment === undefined
      ? await readUploadedBlob(requireBlobs(caller), sessionId, blobId, offset)
      : await readAttachment(v1, sessionId, attachment, offset);
    if (from !== undefined && from.sha256 !== chunk.sha256) {
      throw new HostProtocolError('resync_required', 'The blob changed; read it again from the start.', { reason: 'blob_changed' });
    }
    const next = offset + chunk.length;
    return {
      data: chunk.data, mediaType: chunk.mediaType, byteLength: chunk.byteLength, sha256: chunk.sha256,
      nextCursor: next < chunk.byteLength ? `${next}.${chunk.sha256}` : undefined,
    };
  },

  'run.get': async ({ runId }, v1) => ({ run: toRun(await v1('run.get', { runId }) as RuntimeRunStatus) }),
  'run.list': async ({ sessionId, limit = 50, cursor }, v1) => {
    const runs = [...await v1('run.list', { sessionId }) as readonly RuntimeRunStatus[]].sort(newestRunFirst);
    const from = cursor === undefined ? 0 : runs.findIndex(run => run.runId === cursor) + 1;
    if (cursor !== undefined && from === 0) {
      throw new HostProtocolError('resync_required', 'cursor names no Run of this Session.', { reason: 'cursor_expired' });
    }
    const page = runs.slice(from, from + limit);
    // A page stays small: a Run's answer is read from the Run itself.
    const items = page.map(status => toRun(status.answer === undefined ? status : { ...status, answer: listedAnswer(status.answer) }));
    return { items, nextCursor: from + limit < runs.length ? page.at(-1)?.runId : undefined };
  },
  'run.wait': async ({ runId, timeoutMs = RUN_WAIT_MS }, v1, caller) => {
    const waited = AbortSignal.timeout(timeoutMs);
    const stopWaiting = AbortSignal.any([caller.signal, waited]);
    try {
      await v1('run.await', { runId }, stopWaiting);
    } catch (error: unknown) {
      if (!waited.aborted || caller.signal.aborted) throw error;
    }
    // v1 also answers at once for a Run this Host cannot follow. Reading the Run
    // decides, so a Run that ended while the wait was being given up is still answered.
    const run = toRun(await v1('run.get', { runId }) as RuntimeRunStatus);
    if (run.outcome !== undefined) return { run };
    // Keep the promise that a wait lasts until its limit, or a client asking again would spin.
    if (!stopWaiting.aborted) await new Promise(resolve => stopWaiting.addEventListener('abort', resolve, { once: true }));
    if (caller.signal.aborted) throw new HostProtocolError('cancelled', 'The request was cancelled.');
    throw new HostProtocolError('timeout', 'The Run has not ended yet.', { reason: 'run_in_progress' });
  },
  'run.stop': async ({ runId }, v1) => {
    await v1('run.abort', { runId });
    return {};
  },
  'run.startTool': async ({ requestId, sessionId, tool, input, text, leases }, v1) => {
    // As for an input, the requestId is the input's id: v1 starts one Run per id and refuses another intent under it.
    const { runId } = await v1('run.start', defined({
      sessionId, inputId: requestId, prompt: text, options: { toolInvocation: { name: tool, input } },
      authorization: await leaseAuthorization(v1, leases),
    })) as { readonly runId: string };
    return { run: toRun(await v1('run.get', { runId }) as RuntimeRunStatus) };
  },
  'command.execute': async ({ requestId, sessionId, name, args, leases }, v1) => {
    // As for an input, the requestId is the input's id: v1 answers a command sent again with what it did the first time.
    return toCommandAnswer(v1, await v1('invocations.executeCommand', defined({
      sessionId, inputId: requestId, name, args, authorization: await leaseAuthorization(v1, leases),
    })) as ClientCommandResult);
  },
  // As for a command, the requestId is the input's id: a review sent again is answered with the Run it started.
  'review.start': async ({ requestId, sessionId, args, leases }, v1) =>
    toCommandAnswer(v1, await v1('invocations.startReview', defined({
      sessionId, inputId: requestId, args, authorization: await leaseAuthorization(v1, leases),
    })) as ClientCommandResult),
  'agent.reviewLean': async ({ requestId, sessionId, leases }, v1) =>
    toCommandAnswer(v1, await v1('invocations.startAgentsLean', defined({
      sessionId, inputId: requestId, authorization: await leaseAuthorization(v1, leases),
    })) as ClientCommandResult),
  'run.recover': async ({ runId, leases }, v1) => {
    const read = async (): Promise<RuntimeRunStatus> => await v1('run.get', { runId }) as RuntimeRunStatus;
    const status = await read();
    if (waitsToGoOn(status)) {
      // A Run that stopped for want of room goes on with what the Session runs on now.
      const chosen = await v1('session.settings.get', { sessionId: status.sessionId }) as RuntimeSessionSettings;
      try {
        await v1('run.recover', defined({
          runId, options: defined({ provider: chosen.provider, model: chosen.model, reasoningMode: chosen.reasoningMode }),
          authorization: await leaseAuthorization(v1, leases),
        }));
      } catch (error: unknown) {
        // Refused because another client of the same person continued it first: that is what was asked for.
        const overtaken = error instanceof HostProtocolError && error.kodaxCode === 'conflict' && !waitsToGoOn(await read());
        if (!overtaken) throw error;
      }
    }
    return { run: toRun(await read()) };
  },
  'session.cancel': async ({ requestId, sessionId, ifRunId }, v1, caller) => {
    await v1('session.cancel', { sessionId, expectedRunId: ifRunId, requestId: `${caller.subject}:${requestId}` });
    return {};
  },

  'interaction.list': async ({ sessionId }, v1, caller) => {
    const workspaceRoot = await caller.workspace?.root();
    const items = await v1('interaction.list', defined({ sessionId })) as readonly ClientInteraction[];
    return { items: items.map(interaction => toInteraction(interaction, workspaceRoot)) };
  },
  'interaction.respond': async ({ interactionId, response }, v1) => {
    const { status } = await v1('interaction.respond', {
      requestId: interactionId,
      response: response.kind === 'dismiss' ? { ...response, kind: 'cancel' } : response,
    }) as ClientInteractionResult;
    return { status };
  },
  'permission.grant.list': async (_params, v1) => {
    const { revision, value } = await v1('permission.grants.list') as RuntimeVersionedValue<readonly RuntimePermissionGrant[]>;
    return {
      revision: String(revision),
      items: value.map(grant => ({
        id: grant.id,
        sessionId: grant.scope.sessionId,
        toolName: grant.scope.toolName,
        label: grant.label,
        persistence: grant.persistence,
        createdAt: utcMilliseconds(grant.createdAt),
      })),
    };
  },
  'permission.grant.revoke': async ({ grantId, ifRevision }, v1) => {
    await v1('permission.grants.revoke', defined({
      grantId, expectedRevision: ifRevision === undefined ? undefined : revisionNumber(ifRevision),
    }));
    return {};
  },
  'host.get': async (_params, v1) => {
    const [identity, status, integrations] = await Promise.all([
      v1('runtime.identity') as Promise<RuntimeIdentity>,
      v1('daemon.status') as Promise<RuntimeStatusSnapshot>,
      (v1('daemon.integrations.get') as Promise<RuntimeIntegrationHealth>).catch(unlessUnmanaged),
    ]);
    const unfinished = status.runs.filter(run => runOutcome(run) === undefined);
    const queued = unfinished.filter(run => run.phase === 'queued').length;
    return {
      host: { ...identity, id: identity.runtimeId, startedAt: utcMilliseconds(identity.startedAt) },
      counts: {
        sessions: status.sessions.length,
        runs: status.runs.length,
        activeRuns: unfinished.length - queued,
        queuedRuns: queued,
        workflows: status.workflows.length,
      },
      integrations: integrations && {
        state: integrations.state,
        domains: integrations.domains.map(({ lastReloadAt, diagnostic, ...domain }) => ({
          ...domain,
          lastReloadAt: utcMilliseconds(lastReloadAt),
          diagnostic: diagnostic && { code: diagnostic.code, message: diagnostic.message, at: utcMilliseconds(diagnostic.time) },
        })),
      },
    };
  },
  'host.preflight': async (_params, v1) => {
    const { owner, preflight } = await v1('daemon.management.get') as RuntimeDaemonManagementState;
    return {
      canStop: preflight.canStop,
      // v1 names active child Agent turns twice; the older name is left out.
      blockers: preflight.blockers.filter(blocker => blocker !== 'active_agent_tasks'),
      clients: (preflight.clients ?? []).map(({ name, title, version, clientType, connectedAt }) => ({
        name, title, version, type: clientType, connectedAt: utcMilliseconds(connectedAt),
      })),
      activeRunIds: preflight.activeRuns.map(run => run.runId),
      queuedRunIds: preflight.queuedRuns.map(run => run.runId),
      activeWorkflowIds: preflight.activeWorkflows.map(workflow => workflow.runId),
      activeAgentTurns: preflight.activeAgentTurns,
      pendingInteractions: preflight.pendingPermissions.length + preflight.pendingUserInputs.length,
      pendingBackgroundWork: preflight.pendingBackgroundWork,
      owner: { pid: owner.pid, createdAt: utcMilliseconds(owner.createdAt), processStartIdentity: owner.processStartIdentity },
    };
  },
  'host.stop': async (_params, v1) => {
    await v1('daemon.stop');
    return {};
  },
  'host.logs': async (_params, v1) => {
    const { logFile, entries } = await v1('daemon.logs') as { readonly logFile?: string; readonly entries: readonly RuntimeDaemonLogEntry[] };
    return { logFile, entries: entries.map(({ time, ...entry }) => ({ ...entry, at: utcMilliseconds(time) })) };
  },
  'client.exit.request': async ({ requestId, shutdownHost }, v1) => ({
    exit: toClientExit(await v1('client.exit.request', defined({ requestId, shutdownHost })) as ClientExitReceipt),
  }),
  'client.exit.get': async ({ exitId }, v1) => {
    const receipt = await v1('client.exit.read', { requestId: exitId }) as ClientExitReceipt | null;
    if (receipt === null) {
      throw new HostProtocolError('not_found', 'This client asked for no such exit.', { reason: 'exit_not_found' });
    }
    return { exit: toClientExit(receipt) };
  },
  'client.exit.list': async (_params, v1) => ({
    items: (await v1('client.exit.pending') as readonly ClientExitReceipt[]).map(toClientExit),
  }),
  'session.diagnostics': async ({ sessionId, runId }, v1) => ({
    diagnostics: await v1('session.diagnostics', defined({ sessionId, runId })),
  }),
  'repo.intelligence.inspect': async ({ sessionId }, v1) => v1('repo.intelligence.inspect', { sessionId }),
  'repo.intelligence.prewarm': async ({ sessionId }, v1) => v1('repo.intelligence.prewarm', { sessionId }),

  'config.get': async (_params, v1) => {
    const [config, effective] = await Promise.all([
      v1('config.read'), v1('config.effective') as Promise<RuntimeEffectiveConfigSnapshot>,
    ]);
    return {
      ...toSavedConfig(config),
      effective: {
        persisted: effective.persistedConfig.state,
        entries: effective.entries,
        credentials: effective.credentials,
        application: effective.application,
      },
    };
  },
  // Setting the same fields again changes nothing more, so a repeated update is safe without remembering it.
  'config.update': async ({ patch, ifRevision }, v1) =>
    toSavedConfig(await v1('config.patch', defined({ patch, expectedRevision: ifRevision }))),
  'config.reload': async (_params, v1) => toSavedConfig((await v1('config.reload') as RuntimeConfigReloadResult).config),
  'provider.custom.list': async (_params, v1) => ({ items: await v1('provider.custom.list') }),
  'provider.custom.upsert': async ({ provider }, v1) => ({ provider: await v1('provider.custom.upsert', { config: provider }) }),
  'provider.custom.remove': async ({ name }, v1) => {
    await v1('provider.custom.remove', { name });
    return {};
  },
  'provider.reasoning.probe': async ({ provider, model, efforts, leases }, v1) => ({
    items: await v1('provider.reasoning.probe', defined({ provider, model, efforts, credential: await credentialBinding(v1, leases) })),
  }),
  'provider.reasoning.forget': async ({ provider, model }, v1) => {
    await v1('provider.capabilities.forget', defined({ provider, model }));
    return {};
  },

  'mcp.server.list': async (_params, v1) => ({ items: (await v1('mcp.server.status') as McpServerStatus[]).map(toMcpServer) }),
  'mcp.server.get': async ({ name }, v1) => {
    const config = await v1('mcp.server.get', { name });
    if (config === undefined || config === null) {
      throw new HostProtocolError('not_found', 'The Host has no MCP server of that name.', { reason: 'mcp_server_not_found' });
    }
    return { config };
  },
  'mcp.server.validate': async ({ name, config }, v1) => v1('mcp.server.validate', { name, config }) as Promise<RuntimeMcpValidateResult>,
  'mcp.server.upsert': async ({ name, config }, v1) => ({ config: await v1('mcp.server.upsert', { name, config }) }),
  'mcp.server.remove': async ({ name }, v1) => {
    await v1('mcp.server.remove', { name });
    return {};
  },
  'mcp.server.reload': async (_params, v1) => ({
    items: (await v1('mcp.server.reload') as { readonly servers: McpServerStatus[] }).servers.map(toMcpServer),
  }),
  'mcp.tool.list': async ({ server }, v1) => ({ items: await mcpServerTools(v1, server, false) }),
  'mcp.tool.refresh': async ({ server }, v1) => ({ items: await mcpServerTools(v1, server, true) }),

  'extension.list': async (_params, v1) => toExtensions(await v1('extension.list') as RuntimeExtensionListResult),
  // The reload answers with diagnostics only, so the list is read after it.
  'extension.reload': async (_params, v1) => {
    await v1('extension.reload');
    return toExtensions(await v1('extension.list') as RuntimeExtensionListResult);
  },
  'agent.registration.list': async (_params, v1) => ({ items: await v1('agentRegistrations.list') }),
  'agent.registration.upsert': async ({ registration, ifRevision, ifOwner }, v1) => ({
    registration: await v1('agentRegistrations.upsert', defined({
      registration, expectedConfigurationRevision: ifRevision, expectedManagementOwner: ifOwner,
    })),
  }),
  'agent.registration.setEnabled': async ({ agentId, enabled, claimOwner, ifRevision, ifOwner }, v1) => {
    const registration = await v1('agentRegistrations.setEnabled', defined({
      agentId, enabled, claimOwner, expectedConfigurationRevision: ifRevision, expectedManagementOwner: ifOwner,
    }));
    if (registration !== undefined && registration !== null) return { registration };
    // v1 answers nothing both when the Agent is gone and when a condition failed; only the second is a conflict.
    if (await registeredAgent(v1, agentId)) throw registrationConflict();
    throw new HostProtocolError('not_found', 'The Host has no external Agent of that id.', { reason: 'agent_not_found' });
  },
  'agent.registration.remove': async ({ agentId, ifRevision, ifOwner }, v1) => {
    const removed = await v1('agentRegistrations.remove', defined({
      agentId, expectedConfigurationRevision: ifRevision, expectedManagementOwner: ifOwner,
    })) as boolean;
    // v1 answers `false` both when the Agent is gone and when a condition failed; only the second is a refusal.
    if (!removed && (ifRevision !== undefined || ifOwner !== undefined) && await registeredAgent(v1, agentId)) {
      throw registrationConflict();
    }
    return {};
  },

  'learning.list': async ({ search, carrier, lifecycle, limit, cursor }, v1) => {
    const page = await v1('learning.list', defined({ search, carrier, lifecycle, limit, cursor })) as LearningPage;
    return { items: page.items.map(toLearning), nextCursor: page.nextCursor, revision: page.revision };
  },
  'learning.get': async ({ nameOrSlug }, v1) => ({
    capability: toLearning(await v1('learning.get', { nameOrSlug }) as LearnedCapabilityRecord),
  }),
  'learning.snapshot': async (_params, v1) => v1('learning.snapshot') as Promise<Readonly<Record<string, unknown>>>,
  'learning.events': async ({ afterRevision }, v1) => ({
    items: (await v1('learning.events', defined({ afterRevision })) as readonly LearningEvent[]).map(toLearningEvent),
  }),
  'learning.acknowledge': async ({ nameOrSlug }, v1) => learningDecision(v1, 'learning.acknowledge', { nameOrSlug }),
  'learning.snooze': async ({ nameOrSlug, until }, v1) => (
    learningDecision(v1, 'learning.snooze', { nameOrSlug, until: new Date(until).toISOString() })
  ),
  'learning.reject': async ({ nameOrSlug }, v1) => learningDecision(v1, 'learning.reject', { nameOrSlug }),
  'learning.disable': async ({ nameOrSlug }, v1) => learningDecision(v1, 'learning.disable', { nameOrSlug }),
  'learning.rollback': async ({ nameOrSlug }, v1) => learningDecision(v1, 'learning.rollback', { nameOrSlug }),
  'learning.review': async ({ nameOrSlug }, v1) => learningDecision(v1, 'learning.review', { nameOrSlug }),
  'learning.trust': async ({ nameOrSlug }, v1) => learningDecision(v1, 'learning.trust', { nameOrSlug }),
  'learning.promote': async ({ nameOrSlug, scope }, v1) => learningDecision(v1, 'learning.promote', { nameOrSlug, scope }),
};

// v1 answers a decision with `{ ok: true }`; v2 answers with nothing to read.
async function learningDecision(v1: V1Call, method: RuntimeDaemonMethod, params: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, never>>> {
  await v1(method, params);
  return {};
}

/** A capability without the Host's bookkeeping: scope hashes, provenance and trial bindings stay inside. */
function toLearning(record: LearnedCapabilityRecord): Readonly<Record<string, unknown>> {
  return {
    id: record.capabilityId,
    name: record.displayName,
    slug: record.slug,
    carrier: record.carrier,
    lifecycle: record.lifecycle,
    revision: record.revision,
    createdAt: utcMilliseconds(record.createdAt),
    updatedAt: utcMilliseconds(record.updatedAt),
    lastAction: record.lastAction,
    artifactPath: record.artifactPath,
    previousGoodRevision: record.previousGoodRevision,
    diagnostics: record.diagnostics,
    canary: record.schemaVersion === 2 ? {
      invocationCount: record.canary.invocationCount,
      maxInvocations: record.canary.maxInvocations,
      verifiedSuccesses: record.canary.verifiedSuccesses,
      credibleNegatives: record.canary.credibleNegatives,
    } : undefined,
  };
}

function toLearningEvent(event: LearningEvent): Readonly<Record<string, unknown>> {
  return {
    sequence: event.sequence,
    id: event.eventId,
    kind: event.kind,
    capabilityId: event.capabilityId,
    capabilityRevision: event.capabilityRevision,
    lifecycle: event.lifecycle,
    name: event.displayName,
    slug: event.slug,
    carrier: event.carrier,
    createdAt: utcMilliseconds(event.createdAt),
  };
}

function toExtensions({ active, extensions, diagnostics }: RuntimeExtensionListResult): Readonly<Record<string, unknown>> {
  return { active, extensions, failures: diagnostics?.failures ?? [] };
}

function toMcpServer({ serverId, resolvedTransport, dirty, ...status }: McpServerStatus): Readonly<Record<string, unknown>> {
  return { ...status, name: serverId, transport: resolvedTransport, stale: dirty };
}

/** Reads each server on its own, so one that cannot be reached does not hide the tools of the rest. */
async function mcpServerTools(v1: V1Call, server: string | undefined, forceRefresh: boolean): Promise<readonly unknown[]> {
  const names = Object.keys(await v1('mcp.server.list') as Record<string, unknown>);
  if (server !== undefined && !names.includes(server)) {
    throw new HostProtocolError('not_found', 'The Host has no MCP server of that name.', { reason: 'mcp_server_not_found' });
  }
  return Promise.all((server === undefined ? names : [server]).map(async (name) => {
    try {
      const [list] = await v1('mcp.tool.list', { server: name, forceRefresh }) as McpServerToolList[];
      return defined({ server: name, tools: list?.tools ?? [], cachedAt: list?.cachedAt });
    } catch (error) {
      if (!(error instanceof HostProtocolError) || error.kodaxCode !== 'internal') throw error;
      return { server: name, error: error.message };
    }
  }));
}

/** The saved configuration a client reads, with the revision it may name in `ifRevision`. */
function toSavedConfig(config: unknown): Readonly<Record<string, unknown>> {
  return { config, revision: runtimeConfigRevision(config) };
}

/** A command's answer as v2 names it: the Run it started, or what the Host did itself. */
async function toCommandAnswer(v1: V1Call, answer: ClientCommandResult): Promise<Readonly<Record<string, unknown>>> {
  if (answer.kind === 'completed') return defined({ success: answer.success, message: answer.message });
  return defined({ run: toRun(await v1('run.get', { runId: answer.runId }) as RuntimeRunStatus), message: answer.message });
}

/** A Host without daemon management watches no integrations, so it has none to report. */
function unlessUnmanaged(error: unknown): undefined {
  if (error instanceof HostProtocolError && error.reason === 'client_upgrade_required') return undefined;
  throw error;
}

/**
 * A client's exit as v2 names it. The Host process the receipt names stays
 * out: once that process is gone, the SDK reads the receipt from the Host's
 * files, not over the protocol.
 */
function toClientExit(
  { requestId, requestedAt, updatedAt, recovery, host: { owner: _owner, ...host }, ...receipt }: ClientExitReceipt,
): Readonly<Record<string, unknown>> {
  return {
    ...receipt,
    id: requestId,
    requestedAt: utcMilliseconds(requestedAt),
    updatedAt: utcMilliseconds(updatedAt),
    host,
    recovery: recovery && { ...recovery, checkedAt: utcMilliseconds(recovery.checkedAt) },
  };
}

type VersionedSettings = RuntimeVersionedValue<RuntimeSessionSettings> & { readonly workModeLocked?: boolean };

/**
 * How v1 is told which item names a turn. An id says where its item was shown:
 * a history page puts the revision it was read at in the id, and a view puts
 * the identity of the input or of the answer there. v1 checks either against
 * what it saved, so a made-up id names nothing.
 */
async function itemTurnSelector(sessionId: string, itemId: string): Promise<ClientHistoryTurnSelector> {
  const { parseHistoryEntryItemId } = await import('../client-history.js');
  const paged = parseHistoryEntryItemId(sessionId, itemId, 'history') ?? parseHistoryEntryItemId(sessionId, itemId, 'transcript');
  if (paged !== undefined) return { kind: 'item', itemId, source: 'history', revision: paged.revision };
  const input = `${sessionId}:input:`;
  if (itemId.startsWith(input)) return { kind: 'item', itemId, source: 'view', inputId: itemId.slice(input.length) };
  const output = `${sessionId}:output:`;
  const outputId = itemId.startsWith(output) ? itemId.slice(output.length).split(':', 1)[0] : undefined;
  return { kind: 'item', itemId, source: 'view', ...(outputId ? { outputId } : {}) };
}

/** A turn as v1 names it, packed into the one string a v2 client hands back. */
function turnRef({ historyBoundary, startBoundary, expectedHead }: ClientHistoryTurnTarget): string {
  return Buffer.from(JSON.stringify([
    historyBoundary.sourceRevision, startBoundary.entryId, historyBoundary.entryId, expectedHead,
  ])).toString('base64url');
}

function turnTarget(sessionId: string, ref: string): ClientHistoryTurnTarget {
  let packed: unknown;
  try {
    packed = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'));
  } catch {
    packed = undefined;
  }
  const [sourceRevision, startEntryId, entryId, expectedHead] = Array.isArray(packed) ? packed as readonly unknown[] : [];
  if (typeof sourceRevision !== 'string' || typeof startEntryId !== 'string' || typeof entryId !== 'string'
    || (expectedHead !== null && typeof expectedHead !== 'string')) {
    throw new HostProtocolError('invalid_params', 'This is not a turn that history.resolveTurn named.', {
      reason: 'turn_ref_invalid',
    });
  }
  return {
    sessionId,
    historyBoundary: { kind: 'turn_end', entryId, sourceRevision },
    startBoundary: { entryId: startEntryId, sourceRevision },
    expectedHead,
  };
}

function turnGone(): HostProtocolError {
  return new HostProtocolError('resync_required', 'The conversation changed since this turn was named. Name the turn again.', {
    reason: 'turn_gone',
  });
}

/** A provider request as v2 names it. `requestId` is kept for the intent of a command, so the request's own id is `id`. */
function toRequestStats(
  { requestId, logicalRequestId, previousRequestId, startedAt, endedAt, usage, partialUsage, ...request }: ClientProviderRequestFact,
): Readonly<Record<string, unknown>> {
  return {
    ...request,
    id: requestId,
    logicalId: logicalRequestId,
    previousId: previousRequestId,
    startedAt: utcMilliseconds(startedAt),
    endedAt: utcMilliseconds(endedAt),
    usage: toUsageStats(usage),
    partialUsage: toUsageStats(partialUsage),
  };
}

/** Token counts under the names a Session view gives them. */
function toUsageStats(usage: ClientProviderRequestFact['usage']): Readonly<Record<string, unknown>> | undefined {
  if (usage === undefined) return undefined;
  const { cachedReadTokens, cachedWriteTokens, ...counted } = usage;
  return { ...counted, cacheReadTokens: cachedReadTokens, cacheWriteTokens: cachedWriteTokens };
}

function toActor({ createdAt, updatedAt, ...actor }: AgentActor): Readonly<Record<string, unknown>> {
  return { ...actor, createdAt: utcMilliseconds(createdAt), updatedAt: utcMilliseconds(updatedAt) };
}

function toProgress({ createdAt, ...progress }: AgentProgressItem): Readonly<Record<string, unknown>> {
  return { ...progress, createdAt: utcMilliseconds(createdAt) };
}

/** The executor's checkpoint stays on the Host; the result schema leaves it out. */
/** `requestId` names a client's intent and is not sent back. */
function toTurn({ createdAt, startedAt, completedAt, progress, requestId: _request, ...turn }: AgentTurn): Readonly<Record<string, unknown>> {
  return {
    ...turn,
    createdAt: utcMilliseconds(createdAt),
    startedAt: utcMilliseconds(startedAt),
    completedAt: utcMilliseconds(completedAt),
    progress: progress?.map(toProgress),
  };
}

/** `requestId` names a client's intent and is not sent back. */
function toMessage({ content, createdAt, requestId: _request, ...message }: AgentMailboxMessage): Readonly<Record<string, unknown>> {
  return { ...message, text: content, createdAt: utcMilliseconds(createdAt) };
}

/** A workflow of the Session, read in full. Another Session's workflow is not found, as if it did not exist. */
async function sessionWorkflow(v1: V1Call, sessionId: string, workflowId: string): Promise<Readonly<Record<string, unknown>>> {
  const [summary] = await v1('workflow.list', { runId: workflowId, sessionId }) as readonly RuntimeWorkflowSummary[];
  const process = summary && await v1('workflow.get', { runId: workflowId }) as RuntimeWorkflowSnapshot | null;
  if (!summary || !process) {
    throw new HostProtocolError('not_found', 'The Session has no such workflow.', { reason: 'workflow_not_found' });
  }
  const { ownerRunId } = process.hostMetadata ?? {};
  return {
    ...toWorkflow(summary),
    updatedAt: utcMilliseconds(process.updatedAt),
    runId: ownerRunId || undefined,
    runDir: summary.runDir || undefined,
    goal: process.goal,
    source: process.source,
    savedWorkflowName: process.savedWorkflowName,
    resumedFromId: process.resumedFromRunId,
    activePhaseId: process.activePhaseId,
    phaseCount: process.phaseCount,
    items: process.items.map(({ startedAt, endedAt, ...item }) => ({
      ...item, startedAt: utcMilliseconds(startedAt), endedAt: utcMilliseconds(endedAt),
    })),
    counts: process.counts,
    progress: process.progress,
    tokens: process.tokens,
    latestMessage: process.latestMessage,
    result: summary.resultText ?? process.resultSummary,
    artifacts: process.artifacts,
  };
}

/** A pause or resume v1 refused is done all the same when the workflow is already as asked; otherwise it cannot be. */
async function settledAs(v1: V1Call, sessionId: string, workflowId: string, wanted: 'paused' | 'running'): Promise<void> {
  const { status, stop } = await sessionWorkflow(v1, sessionId, workflowId);
  if (status === wanted && stop === undefined) return;
  const ended = status !== 'running' && status !== 'paused';
  throw new HostProtocolError('invalid_state', ended ? 'The workflow has ended.' : 'The workflow is stopping.', {
    reason: ended ? 'workflow_ended' : 'workflow_stopping',
  });
}

/** The one source a start names, as v1 takes it. */
function workflowSource(
  name: string | undefined,
  request: string | undefined,
  script: { readonly manifest: Readonly<Record<string, unknown>>; readonly source: string } | undefined,
): Readonly<Record<string, unknown>> {
  const sources = [
    name === undefined ? undefined : { kind: 'name', name },
    request === undefined ? undefined : { kind: 'request', request },
    script === undefined ? undefined : { kind: 'inline', ...script },
  ].filter(source => source !== undefined);
  if (sources.length !== 1) {
    throw new HostProtocolError('invalid_params', 'A start names its workflow one way: by name, by request or by script.', {
      reason: 'workflow_source_required',
    });
  }
  return sources[0]!;
}

/**
 * The newest label record of the entry `selector` names, by its id or by its
 * current label, as the lineage resolves it. Undefined when it has none.
 */
function newestLabelRecord(entries: readonly ClientLineageEntry[], selector: string): ClientLineageEntry | undefined {
  const name = selector.trim();
  const records = entries.filter(entry => entry.type === 'label' && entry.targetId !== undefined);
  const current = new Map<string, string | undefined>();
  for (const record of records) current.set(record.targetId!, record.label);
  const targetId = entries.some(entry => entry.id === name && entry.type !== 'label')
    ? name
    : [...current].find(([, label]) => label === name)?.[0];
  return targetId === undefined ? undefined : records.filter(record => record.targetId === targetId).at(-1);
}

function toTreeEntry({ parentId, timestamp, ...entry }: ClientLineageEntry): Readonly<Record<string, unknown>> {
  return defined({ ...entry, parentId: parentId ?? undefined, createdAt: utcMilliseconds(timestamp) });
}

function toGoalAnswer(state: unknown): Readonly<Record<string, unknown>> {
  if (state === null) return {};
  const { tokenBudget, lastBlockerKind, ...goal } = state as ClientSessionGoal;
  return { goal: defined({ ...goal, tokenBudget: tokenBudget ?? undefined, blocker: lastBlockerKind ?? undefined }) };
}

/**
 * v1 refuses a goal command that would change nothing. A command sent again
 * after it worked finds what it asked for in place, so it is answered with the
 * goal as it stands.
 */
async function holdsAlready(
  answer: Promise<Readonly<Record<string, unknown>>>,
  v1: V1Call,
  sessionId: string,
  holds: (goal: ClientSessionGoal | null) => boolean,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    return await answer;
  } catch (error: unknown) {
    if (!(error instanceof HostProtocolError) || error.kodaxCode !== 'conflict') throw error;
    const goal = await v1('session.goal.get', { sessionId }) as ClientSessionGoal | null;
    if (!holds(goal)) throw error;
    return toGoalAnswer(goal);
  }
}

async function registeredAgent(v1: V1Call, agentId: string): Promise<boolean> {
  const listed = await v1('agentRegistrations.list') as readonly { readonly agentId: string }[];
  return listed.some(item => item.agentId === agentId);
}

function registrationConflict(): HostProtocolError {
  return new HostProtocolError('conflict', 'The external Agent no longer meets the conditions.', {
    reason: 'external_agent_registration_conflict',
  });
}

function toSettingsState({ revision, value, workModeLocked }: VersionedSettings): Readonly<Record<string, unknown>> {
  return { settings: value, revision: String(revision), workModeLocked: workModeLocked === true };
}

/** The v1 revision an `ifRevision` names. One the Host never gave out names no state, so it is stale. */
function revisionNumber(ifRevision: string): number {
  if (/^(0|[1-9][0-9]{0,14})$/.test(ifRevision)) return Number(ifRevision);
  throw new HostProtocolError('conflict', 'ifRevision names no revision the Host gave out.', { reason: 'revision_mismatch' });
}

/** How long `run.wait` waits when the client names no limit. */
const RUN_WAIT_MS = 30_000;

function toInput(accepted: ClientInputAcceptance): Readonly<Record<string, unknown>> {
  return { ...accepted, id: accepted.inputId };
}

/** The Session's own order where it has one; Runs from before it had one fall back to when they started. */
function newestRunFirst(left: RuntimeRunStatus, right: RuntimeRunStatus): number {
  return (right.sessionOrder ?? 0) - (left.sessionOrder ?? 0) || right.startedAt.localeCompare(left.startedAt);
}

const ENDED_RUN_PHASES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** Whether the Run stopped at a point it can be continued from and nobody asked it to stop. */
function waitsToGoOn(status: RuntimeRunStatus): boolean {
  return status.phase === 'recovering' && status.stop === undefined;
}

/** A v1 Run in v2 terms: one outcome instead of a phase, a terminal fact, an error and a failure detail to combine. */
function toRun(status: RuntimeRunStatus): { readonly outcome?: unknown; readonly [field: string]: unknown } {
  return {
    id: status.runId,
    sessionId: status.sessionId,
    phase: status.phase,
    inputId: status.productInput?.inputId,
    provider: status.provider,
    model: status.model,
    startedAt: utcMilliseconds(status.startedAt),
    endedAt: utcMilliseconds(status.endedAt),
    stop: status.stop === undefined ? undefined : {
      requestedAt: utcMilliseconds(status.stop.requestedAt),
      confirmed: status.stop.state === 'confirmed',
    },
    outcome: runOutcome(status),
  };
}

function runOutcome(status: RuntimeRunStatus): Readonly<Record<string, unknown>> | undefined {
  const { terminal, failureDetail, lifecycleError } = status;
  if (terminal === undefined && !ENDED_RUN_PHASES.has(status.phase)) {
    // The Host lost track of the Run: whether it ended, and what it changed, is not known.
    return status.phase !== 'unknown' ? undefined : {
      status: 'unknown',
      effects: 'unknown',
      code: lifecycleError?.code ?? 'outcome_unknown',
      message: lifecycleError?.message ?? status.error,
    };
  }
  const ended = terminal?.kind ?? status.phase;
  return {
    status: ended,
    // A Run that ended before the Host recorded terminal facts says nothing about its effects.
    effects: terminal?.effectOutcome ?? 'unknown',
    code: terminal?.code ?? ended,
    message: terminal?.message ?? status.error,
    ...answerFacts(status.answer),
    failure: ended !== 'failed' || failureDetail === undefined ? undefined : {
      kind: failureDetail.failureKind,
      stage: failureDetail.stage,
      code: failureDetail.providerErrorCode,
      safeMessage: failureDetail.safeMessage,
      detail: failureDetail.detail,
      skillName: failureDetail.skillName,
      retryAfterMs: failureDetail.retryAfterMs,
    },
  };
}

/** What a Run answered and used, in v2 terms. */
function answerFacts(answer: RuntimeRunAnswer | undefined): Readonly<Record<string, unknown>> {
  if (answer === undefined) return {};
  return {
    finalText: answer.finalText,
    finalTextTruncated: answer.finalTextTruncated,
    signal: answer.signal?.toLowerCase(),
    signalReason: answer.signalReason,
    limitReached: answer.limitReached,
    usage: answer.usage,
  };
}

function listedAnswer(answer: RuntimeRunAnswer): RuntimeRunAnswer {
  const { finalText: _text, finalTextTruncated: _truncated, ...rest } = answer;
  return rest;
}

/** A chunk of a blob as `blob.read` answers it, with how many bytes it holds. */
interface BlobChunk {
  readonly data: string;
  readonly length: number;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

function requireBlobs(caller: HostCaller): HostBlobStore {
  if (caller.blobs === undefined) {
    throw new HostProtocolError('invalid_state', 'This Host keeps no blobs.', { reason: 'blobs_unavailable' });
  }
  return caller.blobs;
}

async function readUploadedBlob(blobs: HostBlobStore, sessionId: string, blobId: string, offset: number): Promise<BlobChunk> {
  const { data, ref } = await blobs.read(sessionId, blobId, offset);
  return { data: data.toString('base64'), length: data.length, mediaType: ref.mediaType, byteLength: ref.byteLength, sha256: ref.sha256 };
}

/** Reads an item's attachment the way v1 does, in its 512 KiB chunks. */
async function readAttachment(
  v1: V1Call,
  sessionId: string,
  attachment: { readonly itemId: string; readonly index: number },
  offset: number,
): Promise<BlobChunk> {
  const content = await v1('session.view.item', {
    sessionId, itemId: attachment.itemId, part: 'attachment', attachmentIndex: attachment.index, attachmentOffset: offset,
  }) as ClientItemContent | null;
  if (content?.image === undefined) throw new HostProtocolError('not_found', 'The Session holds no such blob.', { reason: 'blob_not_found' });
  const { image } = content;
  return {
    data: image.dataBase64, length: Buffer.byteLength(image.dataBase64, 'base64'),
    mediaType: image.mediaType, byteLength: image.totalLength, sha256: image.sha256,
  };
}

/** An uploaded image as v1 takes an input artifact. Only images go to a model as they are. */
async function uploadedImage(
  blobs: HostBlobStore,
  sessionId: string,
  attachment: { readonly blobId: string; readonly name?: string },
): Promise<Readonly<Record<string, unknown>>> {
  const { path, mediaType } = await blobs.file(sessionId, attachment.blobId);
  if (!mediaType.startsWith('image/')) {
    throw new HostProtocolError('invalid_params', `The blob ${attachment.blobId} is ${mediaType}; an input takes images only.`, {
      reason: 'attachment_not_image',
    });
  }
  return defined({ kind: 'image', path, mediaType, name: attachment.name });
}

/** Where the next chunk of a blob starts, and which bytes the chunks belong to. */
function readBlobCursor(cursor: string): { readonly offset: number; readonly sha256: string } {
  const match = /^(0|[1-9][0-9]{0,14})\.([a-f0-9]{64})$/.exec(cursor);
  if (match === null) throw new HostProtocolError('invalid_params', 'cursor did not come from blob.read.', { reason: 'invalid_cursor' });
  return { offset: Number(match[1]), sha256: match[2]! };
}

/** Where the next page of an item starts, and which writing of its text the pages belong to. */
function readItemCursor(cursor: string): { readonly offset: number; readonly revision: number } {
  const [offset, revision, ...rest] = cursor.split('.')
    .map(part => (/^(0|[1-9][0-9]{0,14})$/.test(part) ? Number(part) : undefined));
  if (offset === undefined || revision === undefined || rest.length > 0) {
    throw new HostProtocolError('invalid_params', 'cursor did not come from item.read.', { reason: 'invalid_cursor' });
  }
  return { offset, revision };
}

/** The Host directory a client named, by either way of naming one. Undefined when it named none. */
async function namedProject(
  caller: HostCaller,
  project: string | undefined,
  projectRoot: string | undefined,
): Promise<string | undefined> {
  if (project !== undefined && projectRoot !== undefined) {
    throw new HostProtocolError('invalid_params', 'Name the project by project or by projectRoot, not both.', {
      reason: 'project_named_twice',
    });
  }
  if (project === undefined) return projectRoot;
  return requireWorkspace(caller).resolve(project);
}

/**
 * The project whose commands and Skills a catalog shows next to the Host-wide
 * ones: the one named, else where a Session created without a project works.
 * A Host with no workspace leaves the choice to v1.
 */
async function catalogProject(
  caller: HostCaller,
  project: string | undefined,
  projectRoot: string | undefined,
): Promise<string | undefined> {
  return await namedProject(caller, project, projectRoot) ?? await caller.workspace?.resolve('.');
}

/** Where a new Session works when its creator named no project. Undefined leaves the choice to the Host. */
async function defaultProject(caller: HostCaller): Promise<string | undefined> {
  if (caller.workspace === undefined && caller.local) return undefined;
  return requireWorkspace(caller).resolve('.');
}

function requireWorkspace(caller: HostCaller): HostWorkspace {
  if (caller.workspace !== undefined) return caller.workspace;
  throw new HostProtocolError('forbidden', 'This Host has no workspace for projects.', { reason: 'workspace_not_configured' });
}

/** The credential lease a Run uses, as v1 binds it to the Run. Fails when this client holds no such lease. */
async function credentialBinding(
  v1: V1Call,
  leases: { readonly credential?: string } | undefined,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const leaseId = leases?.credential;
  if (leaseId === undefined) return undefined;
  const held = await heldLease(v1, leaseId);
  if (held === undefined) throw leaseNotFound();
  return { leaseId, mode: 'scoped', providers: held.providers };
}

/** A Session policy as clients read it: which client instance holds its leases is the Host's to know. */
function toPolicy(policy: RuntimeSession['policy']): Readonly<Record<string, unknown>> {
  if (policy?.leases === undefined) return { ...policy };
  const { holder: _holder, ...leases } = policy.leases;
  return { ...policy, leases };
}

/** The leases a Run uses, as v1 takes them in an execution authorization. Fails when this client holds one of them not. */
async function leaseAuthorization(
  v1: V1Call,
  leases: { readonly credential?: string; readonly hostTools?: string } | undefined,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const credential = await credentialBinding(v1, leases);
  const leaseId = leases?.hostTools;
  if (leaseId !== undefined && await heldHostTools(v1, leaseId) === undefined) throw leaseNotFound();
  const hostTools = leaseId === undefined ? undefined : { leaseId };
  return credential === undefined && hostTools === undefined ? undefined : defined({ credential, hostTools });
}

async function registerCredential(
  { requestId, providers, expiresAt }: { readonly requestId: string; readonly providers: readonly string[]; readonly expiresAt?: number },
  v1: V1Call,
): Promise<Readonly<Record<string, unknown>>> {
  const wanted = { leaseId: requestId, providers, brokerVersion: 2, ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt).toISOString() } : {}) };
  try {
    return toLease(await v1('credential.register', wanted) as RuntimeCredentialLease);
  } catch (error: unknown) {
    if (!(error instanceof HostProtocolError) || error.kodaxCode !== 'conflict') throw error;
    // Sent again, the lease the first one registered answers. Another intent under the same id does not.
    const held = await heldLease(v1, requestId);
    if (held === undefined || !sameLease(held, wanted)) throw requestIdReused();
    return toLease(held);
  }
}

async function registerHostTools(
  { requestId, tools }: { readonly requestId: string; readonly tools: RuntimeHostToolLease['tools'] },
  v1: V1Call,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    return toToolLease(await v1('host_tool.register', { leaseId: requestId, tools }) as RuntimeHostToolLease);
  } catch (error: unknown) {
    if (!(error instanceof HostProtocolError) || error.kodaxCode !== 'conflict') throw error;
    const held = await heldHostTools(v1, requestId);
    if (held === undefined || !isDeepStrictEqual(held.tools, tools)) throw requestIdReused();
    return toToolLease(held);
  }
}

function requestIdReused(): HostProtocolError {
  return new HostProtocolError('conflict', 'Another lease is registered under this requestId.', { reason: 'request_id_reused' });
}

/**
 * A tool lease of this client instance. Asking v1 also sends the calls that
 * waited for the client, which is what a client that asks is back for.
 */
async function heldHostTools(v1: V1Call, leaseId: string): Promise<RuntimeHostToolLease | undefined> {
  return await v1('host_tool.get', { leaseId }) as RuntimeHostToolLease | null ?? undefined;
}

function toToolLease({ id, tools }: RuntimeHostToolLease): Readonly<Record<string, unknown>> {
  return { id, kind: 'host_tool', tools };
}

/**
 * Whether `command.execute` runs a command: a prompt or extension command a person may start.
 * The REPL runs its own commands, and a Skill starts through an input that names it.
 */
function runsThroughHost(command: RuntimeCommandInfo): boolean {
  return (command.source === 'prompt' || command.source === 'extension') && command.userInvocable !== false;
}

/** v1 names the states of a tool call by its own steps; v2 by what the client can do about them. */
const CALL_STATES = {
  prepared: 'waiting', dispatched: 'sent', completed: 'completed', unknown: 'unknown', not_dispatched: 'not_sent',
} as const satisfies Record<RuntimeHostToolInvocationStatus['state'], string>;

/** A lease of this client instance that v2 can use. A lease registered over v1 does not count. */
async function heldLease(v1: V1Call, leaseId: string): Promise<RuntimeCredentialLease | undefined> {
  const held = await v1('credential.get', { leaseId }) as RuntimeCredentialLease | null | undefined;
  return held?.brokerVersion === 2 ? held : undefined;
}

function sameLease(held: RuntimeCredentialLease, wanted: { readonly providers: readonly string[]; readonly expiresAt?: string }): boolean {
  return held.expiresAt === wanted.expiresAt
    && held.providers.length === wanted.providers.length
    && held.providers.every((provider, index) => provider === wanted.providers[index]);
}

function toLease({ id, providers, expiresAt }: RuntimeCredentialLease): Readonly<Record<string, unknown>> {
  return defined({ id, kind: 'credential', providers, expiresAt: utcMilliseconds(expiresAt) });
}

function leaseNotFound(): HostProtocolError {
  return new HostProtocolError('not_found', 'This client instance holds no such lease.', { reason: 'lease_not_found' });
}

/** Passes the Host's request for a provider key on as `lease.request`, cut to the contract. */
function askForCredential(
  notification: RuntimeDaemonNotification, send: (frame: string) => void, protocol: HostRpcProtocol,
): void {
  const { requestId, brokerVersion: _brokerVersion, ...request } = notification.params as Readonly<Record<string, unknown>>;
  const params = protocol.LEASE_NOTIFICATIONS['lease.request'].params.parse({ ...request, callId: requestId, kind: 'credential' });
  // A frame that cannot go out throws, and v1 then fails the model call at once instead of at its time limit.
  send(JSON.stringify(hostRpcNotification('lease.request', params)));
}

/** Passes the Host's call of a client tool on as `lease.request`, cut to the contract. */
function askToRunTool(
  notification: RuntimeDaemonNotification, send: (frame: string) => void, protocol: HostRpcProtocol,
): void {
  const { invocationId, toolName, ...call } = notification.params as Readonly<Record<string, unknown>>;
  const params = protocol.LEASE_NOTIFICATIONS['lease.request'].params.parse({ ...call, callId: invocationId, tool: toolName, kind: 'host_tool' });
  // A frame that cannot go out throws, and v1 then records the call's outcome as unknown.
  send(JSON.stringify(hostRpcNotification('lease.request', params)));
}

/** A v1 Session in v2 terms. Host paths stay in; the contract of the caller's role decides whether they are sent. */
async function toSession(session: RuntimeSession, caller: HostCaller): Promise<Readonly<Record<string, unknown>>> {
  return toSessionResource(session,
    session.workspaceRoot !== undefined ? await caller.workspace?.relative(session.workspaceRoot) : undefined);
}

/** Leaves out what the client did not send, so v1 sees an absent param as absent. */
function defined(params: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

/** The protocol definitions a v2 peer checks frames against. Load them with {@link loadHostRpcProtocol}. */
export type HostRpcProtocol = typeof import('./host-rpc-protocol.js');

/** Whom a network credential speaks for, once the Host checked it. */
export interface HostCredential {
  readonly role: 'user' | 'service';
  /** The credential's own subject, such as a JWT `sub`. A renewal must name the same one. */
  readonly subject: string;
  /** When the credential ends, in UTC milliseconds. The Host hangs up then unless the client renewed it. */
  readonly expiresAt?: number;
}

export interface RuntimeDaemonHostRpcPeerOptions {
  readonly protocol: HostRpcProtocol;
  /** The options a v1 connection on the same endpoint gets, minus its per-connection sinks. */
  readonly dispatcher: Omit<RuntimeDaemonDispatcherOptions, 'notify' | 'disconnect'>;
  /**
   * Checks the credential of a client that is not on the Host's machine. Throws
   * `HostProtocolError` to refuse. The credential then decides the role, not
   * `dispatcher.role`. Without it the peer accepts the local IPC credential only.
   */
  readonly authenticate?: (auth: HostInitializeParams['auth']) => Promise<HostCredential>;
  readonly limits: HostLimits;
  /** Where clients that are not on the Host's machine may name projects. Without it they can name none. */
  readonly workspace?: HostWorkspace;
  /** The paired devices, while the Host listens on the network. */
  readonly devices?: () => HostDeviceAdmin | undefined;
  /** Where the Host keeps the blobs clients upload. Without it the Host takes none. */
  readonly blobs?: HostBlobStore;
  readonly send: (frame: string) => void;
  readonly disconnect: (reason: HostCloseReason) => void;
  /** Whether the client is behind on reading what was already sent. */
  readonly congested: () => boolean;
}

/** The longest delay `setTimeout` holds. A credential that lasts longer re-arms its timer. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export function createRuntimeDaemonHostRpcPeer(
  options: RuntimeDaemonHostRpcPeerOptions,
): RuntimeDaemonFramePeer & { admitted(): boolean; draining(): void } {
  /** Whom the connection speaks for, once it is admitted. */
  let speaker: string | undefined;
  const onInternalError = (method: string, error: unknown, { incidentId, rpcId }: HostIncident): void => emitKodaXDiagnostic({
    source: 'runtime.host-protocol',
    level: 'error',
    message: `${method} failed (incident ${incidentId}).`,
    detail: {
      incidentId,
      ...(rpcId !== undefined ? { rpcId } : {}),
      ...(speaker !== undefined ? { subject: speaker } : {}),
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    },
  });
  /** The subscriptions of this connection, once it is admitted. */
  let views: HostViewStreams | undefined;
  const connection = options.protocol.createHostConnection({
    methods: options.protocol.HOST_METHODS,
    send: options.send,
    disconnect: options.disconnect,
    onInternalError,
    admit: async ({ client, auth }) => {
      const access = await admitCredential(auth);
      let credential = access.credential;
      const { role } = access;
      const subject = runtimeAuthorizationSubject(role, access.tokenSubject);
      if (subject === undefined) {
        throw new HostProtocolError('unauthorized', 'This credential does not name whom the connection speaks for.', {
          reason: 'unsupported_auth_scheme',
        });
      }
      speaker = subject;
      let expiry: ReturnType<typeof setTimeout> | undefined;
      const expireAt = (expiresAt: number | undefined): void => {
        clearTimeout(expiry);
        if (expiresAt === undefined) return;
        expiry = setTimeout(() => {
          if (Date.now() >= expiresAt) options.disconnect('credential');
          else expireAt(expiresAt);
        }, Math.min(Math.max(expiresAt - Date.now(), 0), MAX_TIMER_MS));
      };
      const renew = async (token: string, afterAnswer: (run: () => void) => void): Promise<{ expiresAt?: number }> => {
        if (credential?.expiresAt === undefined || options.authenticate === undefined || auth === undefined) {
          throw new HostProtocolError('invalid_state', "This connection's credential does not expire, so it has nothing to renew.", {
            reason: 'credential_does_not_expire',
          });
        }
        // A token that is not good, or a check the Host cannot make now, leaves the current credential in force.
        const next = await options.authenticate({ scheme: auth.scheme, token });
        if (next.role !== credential.role || next.subject !== credential.subject) {
          reportHostSecurityEvent({ event: 'auth_failed', reason: 'subject_changed' });
          afterAnswer(() => options.disconnect('credential'));
          throw new HostProtocolError('unauthorized', 'A renewal must name the subject and role the connection speaks for.', {
            reason: 'subject_changed',
          });
        }
        credential = next;
        expireAt(next.expiresAt);
        return next.expiresAt !== undefined ? { expiresAt: next.expiresAt } : {};
      };
      const streams = createHostViewStreams({
        contract: runtimeRoleHasPlane(role, 'local')
          ? options.protocol.LocalSessionView
          : options.protocol.SessionView,
        ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
        send: options.send,
        congested: options.congested,
        closeObservation: async (subscriptionId) => { await v1('session.view.close', { subscriptionId }); },
        onInternalError,
      });
      const dispatcher = createRuntimeDaemonDispatcher({
        ...options.dispatcher,
        role,
        tokenSubject: access.tokenSubject,
        // v1 hangs up on a connection when a newer one of the same client instance takes over.
        disconnect: () => options.disconnect('replaced'),
        // The Host's calls to this client go out on this connection. A reconnect of the same instance takes its leases over.
        notify: (notification) => {
          if (notification.method === 'credential.request') askForCredential(notification, options.send, options.protocol);
          else if (notification.method === 'host_tool.invoke') askToRunTool(notification, options.send, options.protocol);
          else streams.receive(notification);
        },
      });
      let sequence = 0;
      const v1 = async (
        method: RuntimeDaemonMethod,
        params?: Readonly<Record<string, unknown>>,
        signal?: AbortSignal,
      ): Promise<unknown> => {
        // An abort that already happened would never be heard below.
        if (signal?.aborted === true) throw new HostProtocolError('cancelled', 'The request was cancelled.');
        const id = `v2_${++sequence}`;
        const cancel = (): void => {
          void dispatcher.handle(createRuntimeDaemonRequest(`v2_${++sequence}`, 'request.cancel', { requestId: id }));
        };
        signal?.addEventListener('abort', cancel, { once: true });
        try {
          const response = await dispatcher.handle(createRuntimeDaemonRequest(id, method, params));
          if (response.kind === 'error') throw hostErrorFromV1(response.error);
          return response.result;
        } finally {
          signal?.removeEventListener('abort', cancel);
        }
      };
      try {
        // A network credential was checked above; only the local one is the shared secret v1 compares.
        await v1('initialize', {
          ...(credential === undefined && auth !== undefined ? { token: auth.token } : {}), clientInfo: client, connectionPurpose: 'client',
        });
      } catch (error: unknown) {
        dispatcher.close();
        throw error;
      }
      const { identity } = options.dispatcher.runtime;
      const caller: Omit<HostCaller, 'afterAnswer' | 'signal'> = {
        subject,
        local: runtimeRoleHasPlane(role, 'local'),
        service: role === 'service',
        ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
        ...(options.blobs !== undefined ? { blobs: options.blobs } : {}),
        views: streams,
      };
      views = streams;
      expireAt(credential?.expiresAt);
      return {
        role,
        subject,
        host: { id: identity.runtimeId, version: identity.version },
        features: [],
        locks: [],
        limits: options.limits,
        ...(credential?.expiresAt !== undefined ? { expiresAt: credential.expiresAt } : {}),
        call: async (method, params, signal, afterAnswer) => {
          if (method === 'auth.renew') return renew(String(params.token), afterAnswer);
          if (Object.hasOwn(DEVICE_HANDLERS, method)) return serveDevices(method as DeviceMethod, params);
          // The connection passes only methods of the table, with params that passed that method's schema.
          const handlers = V1_HANDLERS as Readonly<Record<string,
            (params: unknown, v1: V1Call, caller: HostCaller) => Promise<unknown>>>;
          if (!Object.hasOwn(handlers, method)) throw new Error(`No handler serves the v2 method ${method}.`);
          return handlers[method]!(params, (v1Method, v1Params, sooner) => v1(v1Method, v1Params, sooner ?? signal),
            { ...caller, signal, afterAnswer });
        },
        close: () => {
          clearTimeout(expiry);
          streams.close();
          dispatcher.close();
        },
      };
    },
  });

  function serveDevices(method: DeviceMethod, params: unknown): unknown {
    const devices = options.devices?.();
    if (devices === undefined) {
      throw new HostProtocolError('invalid_state', 'This Host does not listen on the network, so it has no devices to pair.', {
        reason: 'not_listening',
      });
    }
    const handler = DEVICE_HANDLERS[method] as (params: unknown, devices: HostDeviceAdmin) => unknown;
    return handler(params, devices);
  }

  /** Whom the connection speaks for: the network credential when there is an authenticator, else the endpoint's role. */
  async function admitCredential(auth: HostInitializeParams['auth']): Promise<{
    readonly role: RuntimeConnectionRole;
    readonly tokenSubject?: string;
    readonly credential?: HostCredential;
  }> {
    const unsupported = (message: string): HostProtocolError =>
      new HostProtocolError('unauthorized', message, { reason: 'unsupported_auth_scheme' });
    if (options.authenticate === undefined) {
      if (auth?.scheme !== 'ipc') throw unsupported('This endpoint accepts the local IPC credential only.');
      return { role: options.dispatcher.role, tokenSubject: options.dispatcher.tokenSubject };
    }
    if (auth?.scheme === 'ipc') throw unsupported('A network connection cannot use the local IPC credential.');
    const credential = await options.authenticate(auth);
    // A person's connections all act for the person; the subject still names which login or device it was, for the security log.
    return { role: credential.role, tokenSubject: credential.subject, credential };
  }

  return {
    receive: connection.receive,
    close: connection.close,
    drained: () => views?.drained(),
    admitted: () => views !== undefined,
    draining() {
      // A client still in its handshake learns of it from the refusal or the close that follows.
      if (views === undefined) return;
      const params = options.protocol.HOST_NOTIFICATIONS['host.draining'].params.parse({});
      options.send(JSON.stringify(hostRpcNotification('host.draining', params)));
    },
  };
}

/** v1 names the quarantine by its cause; v2 by the state `session.recovery` reports. */
const QUARANTINE_REASONS: Readonly<Record<string, string>> = {
  actor_settlement_not_persisted: 'session_recovering',
  recovery_stalled: 'recovery_stalled',
};

/** Exported for tests. */
export function hostErrorFromV1(error: RuntimeDaemonError): HostProtocolError {
  const { data } = error;
  // v1 uses `conflict` for many things; its data tells a stale revision from the rest.
  const conflict = error.code === 'conflict' && typeof data === 'object' && data !== null
    ? (data as { readonly conflict?: unknown }).conflict : undefined;
  // The pages a cursor belonged to are gone, so the client reads again from the first.
  if (conflict === 'cursor_expired') return new HostProtocolError('resync_required', error.message, { reason: 'cursor_expired' });
  // A quarantined Session: `session.recovery` in the view says when it takes Runs again.
  const quarantine = QUARANTINE_REASONS[String(conflict)];
  if (quarantine !== undefined) return new HostProtocolError('invalid_state', error.message, { reason: quarantine });
  const staleRevision = conflict === 'revision_conflict';
  // Where v1 says more than its code, such as what changed or which conflict, the client is told that.
  const said = typeof data === 'object' && data !== null ? (data as { readonly reason?: unknown }).reason : undefined;
  const detail = typeof conflict === 'string' ? conflict : typeof said === 'string' ? said : undefined;
  return new HostProtocolError(V1_ERROR_CODES[error.code] ?? 'internal', error.message, {
    reason: staleRevision ? 'revision_mismatch' : detail ?? error.code,
  });
}
