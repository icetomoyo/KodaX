export const KODAX_DAEMON_PROTOCOL = 'kodax-runtime-daemon';
export const KODAX_DAEMON_PROTOCOL_VERSION = 1;

export type RuntimeDaemonMethod =
  | 'initialize'
  | 'runtime.initialize'
  | 'ping'
  | 'runtime.identity'
  | 'runtime.status'
  | 'runtime.shutdown'
  | 'runtime.capabilities'
  | 'daemon.status'
  | 'daemon.stop'
  | 'daemon.logs'
  | 'daemon.preflight'
  | 'daemon.management.get'
  | 'daemon.rollbackToInline'
  | 'operation.get'
  | 'session.create'
  | 'session.load'
  | 'session.list'
  | 'session.status'
  | 'session.transcript'
  | 'session.transcript.page'
  | 'session.transcript.entryChunk'
  | 'session.transcript.search'
  | 'session.conversation'
  | 'session.conversation.page'
  | 'session.conversation.entryChunk'
  | 'session.observe'
  | 'session.diagnostics'
  | 'session.fork'
  | 'session.notice.append'
  | 'session.rewind'
  | 'session.active_entry.set'
  | 'session.activeEntry.set'
  | 'session.compact'
  | 'session.archive'
  | 'session.unarchive'
  | 'session.delete'
  | 'session.settings.get'
  | 'session.settings.getVersioned'
  | 'session.autoMode.getStats'
  | 'session.settings.update'
  | 'session.settings.updateVersioned'
  | 'run.start'
  | 'run.input.submit'
  | 'run.get'
  | 'run.list'
  | 'run.await'
  | 'run.abort'
  | 'run.model.set'
  | 'run.provider.set'
  | 'run.reasoning.set'
  | 'run.setModel'
  | 'run.setProvider'
  | 'run.setReasoning'
  | 'request.cancel'
  | 'request.ack'
  | 'event.subscribe'
  | 'event.unsubscribe'
  | 'event.replay'
  | 'permission.list'
  | 'permission.listPending'
  | 'permission.request'
  | 'permission.respond'
  | 'permission.grants.list'
  | 'permission.grants.revoke'
  | 'user_input.listPending'
  | 'user_input.respond'
  | 'user_input.dismiss'
  | 'credential.register'
  | 'credential.get'
  | 'credential.revoke'
  | 'credential.supply'
  | 'host_tool.register'
  | 'host_tool.get'
  | 'host_tool.invocation.get'
  | 'host_tool.revoke'
  | 'host_tool.complete'
  | 'workflow.list'
  | 'workflow.get'
  | 'workflow.subscribe'
  | 'workflow.unsubscribe'
  | 'workflow.pause'
  | 'workflow.resume'
  | 'workflow.stop'
  | 'learning.list'
  | 'learning.get'
  | 'learning.snapshot'
  | 'learning.events'
  | 'learning.acknowledge'
  | 'learning.snooze'
  | 'learning.reject'
  | 'learning.disable'
  | 'learning.rollback'
  | 'learning.promote'
  | 'learning.review'
  | 'learning.trust'
  | 'config.read'
  | 'config.effective'
  | 'config.patch'
  | 'config.reload'
  | 'model.list'
  | 'provider.list'
  | 'provider.custom.list'
  | 'provider.custom.upsert'
  | 'provider.custom.remove'
  | 'mcp.server.list'
  | 'mcp.server.get'
  | 'mcp.server.validate'
  | 'mcp.server.upsert'
  | 'mcp.server.delete'
  | 'mcp.server.remove'
  | 'mcp.server.reload'
  | 'mcp.tool.list'
  | 'extension.list'
  | 'extension.reload'
  | 'command.list'
  | 'command.resolve'
  | 'skill.list'
  | 'skill.describe'
  | 'skill.read'
  | 'artifact.create'
  | 'artifact.get'
  | 'artifact.delete'
  | 'agentRegistrations.list'
  | 'agentRegistrations.upsert'
  | 'agentRegistrations.setEnabled'
  | 'agentRegistrations.remove'
  | 'agents.listDispatchable'
  | 'agents.describe'
  | 'agents.preflight'
  | 'agents.tree'
  | 'agents.detail'
  | 'agents.spawn'
  | 'agents.send'
  | 'agents.followup'
  | 'agents.interrupt'
  | 'agents.output'
  | 'agents.events'
  | 'agents.wait'
  | 'context.budget.get'
  | 'tool.exposure.preview'
  | 'provider.cache.diagnostics.get';

export type RuntimeDaemonRetiredMethod =
  | 'agentTasks.list'
  | 'agentTasks.start'
  | 'agentTasks.get'
  | 'agentTasks.events'
  | 'agentTasks.wait'
  | 'agentTasks.sendInput'
  | 'agentTasks.cancel'
  | 'agentTasks.reconcile';

export type RuntimeDaemonWireMethod = RuntimeDaemonMethod | RuntimeDaemonRetiredMethod;

export type RuntimeDaemonMutationMethod =
  | 'runtime.shutdown'
  | 'daemon.stop'
  | 'daemon.rollbackToInline'
  | 'session.create'
  | 'session.fork'
  | 'session.notice.append'
  | 'session.rewind'
  | 'session.active_entry.set'
  | 'session.activeEntry.set'
  | 'session.compact'
  | 'session.archive'
  | 'session.unarchive'
  | 'session.delete'
  | 'session.settings.update'
  | 'session.settings.updateVersioned'
  | 'run.start'
  | 'run.input.submit'
  | 'run.abort'
  | 'run.model.set'
  | 'run.provider.set'
  | 'run.reasoning.set'
  | 'run.setModel'
  | 'run.setProvider'
  | 'run.setReasoning'
  | 'permission.request'
  | 'permission.respond'
  | 'permission.grants.revoke'
  | 'user_input.respond'
  | 'user_input.dismiss'
  | 'workflow.pause'
  | 'workflow.resume'
  | 'workflow.stop'
  | 'learning.acknowledge'
  | 'learning.snooze'
  | 'learning.reject'
  | 'learning.disable'
  | 'learning.rollback'
  | 'learning.promote'
  | 'learning.review'
  | 'learning.trust'
  | 'config.patch'
  | 'config.reload'
  | 'provider.custom.upsert'
  | 'provider.custom.remove'
  | 'mcp.server.upsert'
  | 'mcp.server.delete'
  | 'mcp.server.remove'
  | 'mcp.server.reload'
  | 'extension.reload'
  | 'artifact.create'
  | 'artifact.delete'
  | 'agentRegistrations.upsert'
  | 'agentRegistrations.setEnabled'
  | 'agentRegistrations.remove'
  | 'agents.spawn'
  | 'agents.send'
  | 'agents.followup'
  | 'agents.interrupt';

export type RuntimeDaemonNotificationMethod =
  | 'event'
  | 'observation.invalidated'
  | 'credential.request'
  | 'host_tool.invoke'
  | 'runtime.warning';

export interface RuntimeDaemonError {
  readonly code: RuntimeDaemonErrorCode;
  readonly message: string;
  readonly data?: unknown;
}

export type RuntimeDaemonErrorCode =
  | 'invalid_frame'
  | 'invalid_request'
  | 'invalid_params'
  | 'not_initialized'
  | 'method_not_found'
  | 'unauthorized'
  | 'permission_denied'
  | 'conflict'
  | 'not_found'
  | 'session_not_admitted'
  | 'cancelled'
  | 'overloaded'
  | 'client_upgrade_required'
  | 'operation_required'
  | 'operation_epoch_mismatch'
  | 'operation_id_reuse'
  | 'operation_interrupted'
  | 'operation_unknown'
  | 'control_history_untrusted'
  | 'resync_required'
  | 'read_timeout'
  | 'read_cancelled'
  | 'data_changed'
  | 'observation_invalidated'
  | 'runtime_changed'
  | 'data_corrupt'
  | 'version_incompatible'
  | 'credential_unavailable'
  | 'host_tool_unavailable'
  | 'host_tool_unknown'
  | 'internal_error';

interface RuntimeDaemonFrameBase {
  readonly protocol: typeof KODAX_DAEMON_PROTOCOL;
  readonly version: typeof KODAX_DAEMON_PROTOCOL_VERSION;
}

export interface RuntimeDaemonRequest<
  Method extends RuntimeDaemonWireMethod = RuntimeDaemonMethod,
> extends RuntimeDaemonFrameBase {
  readonly kind: 'request';
  readonly id: string;
  readonly method: Method;
  readonly params?: unknown;
  readonly operation?: RuntimeDaemonOperationEnvelope;
}

export interface RuntimeDaemonOperationEnvelope {
  readonly operationId: string;
  readonly journalEpoch: string;
}

export interface RuntimeDaemonSuccessResponse extends RuntimeDaemonFrameBase {
  readonly kind: 'response';
  readonly id: string;
  readonly result: unknown;
}

export interface RuntimeDaemonErrorResponse extends RuntimeDaemonFrameBase {
  readonly kind: 'error';
  readonly id?: string;
  readonly error: RuntimeDaemonError;
}

export interface RuntimeDaemonNotification extends RuntimeDaemonFrameBase {
  readonly kind: 'notification';
  readonly method: RuntimeDaemonNotificationMethod;
  readonly params?: unknown;
}

export type RuntimeDaemonFrame =
  | RuntimeDaemonRequest<RuntimeDaemonWireMethod>
  | RuntimeDaemonSuccessResponse
  | RuntimeDaemonErrorResponse
  | RuntimeDaemonNotification;

export const RUNTIME_DAEMON_METHODS: readonly RuntimeDaemonMethod[] = [
  'initialize',
  'runtime.initialize',
  'ping',
  'runtime.identity',
  'runtime.status',
  'runtime.shutdown',
  'runtime.capabilities',
  'daemon.status',
  'daemon.stop',
  'daemon.logs',
  'daemon.preflight',
  'daemon.management.get',
  'daemon.rollbackToInline',
  'operation.get',
  'session.create',
  'session.load',
  'session.list',
  'session.status',
  'session.transcript',
  'session.transcript.page',
  'session.transcript.entryChunk',
  'session.transcript.search',
  'session.conversation',
  'session.conversation.page',
  'session.conversation.entryChunk',
  'session.observe',
  'session.diagnostics',
  'session.fork',
  'session.notice.append',
  'session.rewind',
  'session.active_entry.set',
  'session.activeEntry.set',
  'session.compact',
  'session.archive',
  'session.unarchive',
  'session.delete',
  'session.settings.get',
  'session.settings.getVersioned',
  'session.autoMode.getStats',
  'session.settings.update',
  'session.settings.updateVersioned',
  'run.start',
  'run.input.submit',
  'run.get',
  'run.list',
  'run.await',
  'run.abort',
  'run.model.set',
  'run.provider.set',
  'run.reasoning.set',
  'run.setModel',
  'run.setProvider',
  'run.setReasoning',
  'request.cancel',
  'request.ack',
  'event.subscribe',
  'event.unsubscribe',
  'event.replay',
  'permission.list',
  'permission.listPending',
  'permission.request',
  'permission.respond',
  'permission.grants.list',
  'permission.grants.revoke',
  'user_input.listPending',
  'user_input.respond',
  'user_input.dismiss',
  'credential.register',
  'credential.get',
  'credential.revoke',
  'credential.supply',
  'host_tool.register',
  'host_tool.get',
  'host_tool.invocation.get',
  'host_tool.revoke',
  'host_tool.complete',
  'workflow.list',
  'workflow.get',
  'workflow.subscribe',
  'workflow.unsubscribe',
  'workflow.pause',
  'workflow.resume',
  'workflow.stop',
  'learning.list',
  'learning.get',
  'learning.snapshot',
  'learning.events',
  'learning.acknowledge',
  'learning.snooze',
  'learning.reject',
  'learning.disable',
  'learning.rollback',
  'learning.promote',
  'learning.review',
  'learning.trust',
  'config.read',
  'config.effective',
  'config.patch',
  'config.reload',
  'model.list',
  'provider.list',
  'provider.custom.list',
  'provider.custom.upsert',
  'provider.custom.remove',
  'mcp.server.list',
  'mcp.server.get',
  'mcp.server.validate',
  'mcp.server.upsert',
  'mcp.server.delete',
  'mcp.server.remove',
  'mcp.server.reload',
  'mcp.tool.list',
  'extension.list',
  'extension.reload',
  'command.list',
  'command.resolve',
  'skill.list',
  'skill.describe',
  'skill.read',
  'artifact.create',
  'artifact.get',
  'artifact.delete',
  'agentRegistrations.list',
  'agentRegistrations.upsert',
  'agentRegistrations.setEnabled',
  'agentRegistrations.remove',
  'agents.listDispatchable',
  'agents.describe',
  'agents.preflight',
  'agents.tree',
  'agents.detail',
  'agents.spawn',
  'agents.send',
  'agents.followup',
  'agents.interrupt',
  'agents.output',
  'agents.events',
  'agents.wait',
  'context.budget.get',
  'tool.exposure.preview',
  'provider.cache.diagnostics.get',
];

export const RUNTIME_DAEMON_MUTATION_METHODS: readonly RuntimeDaemonMutationMethod[] = [
  'runtime.shutdown',
  'daemon.stop',
  'daemon.rollbackToInline',
  'session.create',
  'session.fork',
  'session.notice.append',
  'session.rewind',
  'session.active_entry.set',
  'session.activeEntry.set',
  'session.compact',
  'session.archive',
  'session.unarchive',
  'session.delete',
  'session.settings.update',
  'session.settings.updateVersioned',
  'run.start',
  'run.input.submit',
  'run.abort',
  'run.model.set',
  'run.provider.set',
  'run.reasoning.set',
  'run.setModel',
  'run.setProvider',
  'run.setReasoning',
  'permission.request',
  'permission.respond',
  'permission.grants.revoke',
  'user_input.respond',
  'user_input.dismiss',
  'workflow.pause',
  'workflow.resume',
  'workflow.stop',
  'learning.acknowledge',
  'learning.snooze',
  'learning.reject',
  'learning.disable',
  'learning.rollback',
  'learning.promote',
  'learning.review',
  'learning.trust',
  'config.patch',
  'config.reload',
  'provider.custom.upsert',
  'provider.custom.remove',
  'mcp.server.upsert',
  'mcp.server.delete',
  'mcp.server.remove',
  'mcp.server.reload',
  'extension.reload',
  'artifact.create',
  'artifact.delete',
  'agentRegistrations.upsert',
  'agentRegistrations.setEnabled',
  'agentRegistrations.remove',
  'agents.spawn',
  'agents.send',
  'agents.followup',
  'agents.interrupt',
];

const RETIRED_METHODS: readonly RuntimeDaemonRetiredMethod[] = [
  'agentTasks.list',
  'agentTasks.start',
  'agentTasks.get',
  'agentTasks.events',
  'agentTasks.wait',
  'agentTasks.sendInput',
  'agentTasks.cancel',
  'agentTasks.reconcile',
];
const REQUEST_METHODS: ReadonlySet<string> = new Set<RuntimeDaemonWireMethod>([
  ...RUNTIME_DAEMON_METHODS,
  ...RETIRED_METHODS,
]);
const MUTATION_METHODS: ReadonlySet<string> = new Set<RuntimeDaemonMutationMethod>(
  RUNTIME_DAEMON_MUTATION_METHODS,
);

// Reverse-bridge control requests mutate daemon-owned live state, but must not
// enter the durable operation journal: credential.supply can contain a secret,
// while supply/complete are already reconciled by their one-shot request IDs.
const REVERSE_BRIDGE_STATE_METHODS: ReadonlySet<RuntimeDaemonMethod> = new Set([
  'credential.register',
  'credential.revoke',
  'credential.supply',
  'host_tool.register',
  'host_tool.revoke',
  'host_tool.complete',
]);

const NOTIFICATION_METHODS: ReadonlySet<string> = new Set<RuntimeDaemonNotificationMethod>([
  'event',
  'observation.invalidated',
  'credential.request',
  'host_tool.invoke',
  'runtime.warning',
]);

const ERROR_CODES: ReadonlySet<string> = new Set<RuntimeDaemonErrorCode>([
  'invalid_frame',
  'invalid_request',
  'invalid_params',
  'not_initialized',
  'method_not_found',
  'unauthorized',
  'permission_denied',
  'conflict',
  'not_found',
  'session_not_admitted',
  'cancelled',
  'overloaded',
  'client_upgrade_required',
  'operation_required',
  'operation_epoch_mismatch',
  'operation_id_reuse',
  'operation_interrupted',
  'operation_unknown',
  'control_history_untrusted',
  'resync_required',
  'read_timeout',
  'read_cancelled',
  'data_changed',
  'observation_invalidated',
  'runtime_changed',
  'data_corrupt',
  'version_incompatible',
  'credential_unavailable',
  'host_tool_unavailable',
  'host_tool_unknown',
  'internal_error',
]);

export function createRuntimeDaemonRequest(
  id: string,
  method: RuntimeDaemonMethod,
  params?: unknown,
  operation?: RuntimeDaemonOperationEnvelope,
): RuntimeDaemonRequest {
  return {
    protocol: KODAX_DAEMON_PROTOCOL,
    version: KODAX_DAEMON_PROTOCOL_VERSION,
    kind: 'request',
    id,
    method,
    ...(params !== undefined ? { params } : {}),
    ...(operation !== undefined ? { operation } : {}),
  };
}

export function isRuntimeDaemonMutationMethod(
  method: RuntimeDaemonMethod,
): method is RuntimeDaemonMutationMethod {
  return MUTATION_METHODS.has(method);
}

export function isRuntimeDaemonDrainingSensitiveMethod(
  method: RuntimeDaemonMethod,
): boolean {
  return isRuntimeDaemonMutationMethod(method) || REVERSE_BRIDGE_STATE_METHODS.has(method);
}

export function isRuntimeDaemonRetiredMethod(
  method: RuntimeDaemonWireMethod,
): method is RuntimeDaemonRetiredMethod {
  return (RETIRED_METHODS as readonly RuntimeDaemonWireMethod[]).includes(method);
}

export function createRuntimeDaemonSuccessResponse(
  id: string,
  result: unknown,
): RuntimeDaemonSuccessResponse {
  return {
    protocol: KODAX_DAEMON_PROTOCOL,
    version: KODAX_DAEMON_PROTOCOL_VERSION,
    kind: 'response',
    id,
    result: result === undefined ? null : result,
  };
}

export function createRuntimeDaemonErrorResponse(
  error: RuntimeDaemonError,
  id?: string,
): RuntimeDaemonErrorResponse {
  return {
    protocol: KODAX_DAEMON_PROTOCOL,
    version: KODAX_DAEMON_PROTOCOL_VERSION,
    kind: 'error',
    ...(id !== undefined ? { id } : {}),
    error,
  };
}

export function createRuntimeDaemonNotification(
  method: RuntimeDaemonNotificationMethod,
  params?: unknown,
): RuntimeDaemonNotification {
  return {
    protocol: KODAX_DAEMON_PROTOCOL,
    version: KODAX_DAEMON_PROTOCOL_VERSION,
    kind: 'notification',
    method,
    ...(params !== undefined ? { params } : {}),
  };
}

export function isRuntimeDaemonRequest(
  value: unknown,
): value is RuntimeDaemonRequest<RuntimeDaemonWireMethod> {
  if (!isFrameBase(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.kind === 'request'
    && typeof frame.id === 'string'
    && frame.id.length > 0
    && typeof frame.method === 'string'
    && REQUEST_METHODS.has(frame.method)
    && (frame.operation === undefined || isRuntimeDaemonOperationEnvelope(frame.operation));
}

export function isRuntimeDaemonSuccessResponse(
  value: unknown,
): value is RuntimeDaemonSuccessResponse {
  if (!isFrameBase(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.kind === 'response'
    && typeof frame.id === 'string'
    && frame.id.length > 0
    && Object.prototype.hasOwnProperty.call(frame, 'result');
}

export function isRuntimeDaemonErrorResponse(value: unknown): value is RuntimeDaemonErrorResponse {
  if (!isFrameBase(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.kind === 'error'
    && (frame.id === undefined || typeof frame.id === 'string')
    && isRuntimeDaemonError(frame.error);
}

export function isRuntimeDaemonNotification(value: unknown): value is RuntimeDaemonNotification {
  if (!isFrameBase(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.kind === 'notification'
    && typeof frame.method === 'string'
    && NOTIFICATION_METHODS.has(frame.method);
}

export function isRuntimeDaemonFrame(value: unknown): value is RuntimeDaemonFrame {
  return isRuntimeDaemonRequest(value)
    || isRuntimeDaemonSuccessResponse(value)
    || isRuntimeDaemonErrorResponse(value)
    || isRuntimeDaemonNotification(value);
}

export function parseRuntimeDaemonFrame(json: string): RuntimeDaemonFrame | RuntimeDaemonErrorResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return invalidFrame('Frame is not valid JSON.');
  }

  if (!isRuntimeDaemonFrame(parsed)) {
    return invalidFrame('Frame does not match the runtime daemon protocol.');
  }
  return parsed;
}

function invalidFrame(message: string): RuntimeDaemonErrorResponse {
  return createRuntimeDaemonErrorResponse({
    code: 'invalid_frame',
    message,
  });
}

function isFrameBase(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const frame = value as Record<string, unknown>;
  return frame.protocol === KODAX_DAEMON_PROTOCOL
    && frame.version === KODAX_DAEMON_PROTOCOL_VERSION;
}

function isRuntimeDaemonError(value: unknown): value is RuntimeDaemonError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const error = value as Record<string, unknown>;
  return typeof error.code === 'string'
    && ERROR_CODES.has(error.code)
    && typeof error.message === 'string';
}

function isRuntimeDaemonOperationEnvelope(value: unknown): value is RuntimeDaemonOperationEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const operation = value as Record<string, unknown>;
  return typeof operation.operationId === 'string'
    && operation.operationId.length > 0
    && typeof operation.journalEpoch === 'string'
    && operation.journalEpoch.length > 0;
}
