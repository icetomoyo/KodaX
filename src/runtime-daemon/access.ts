import type { RuntimeDaemonMethod } from './protocol.js';

/**
 * Who a connection speaks for. The transport that accepted the connection
 * decides it: the local IPC endpoint is the owner; a network transport reads
 * it from the verified token. A connection without a role can call nothing.
 */
export type RuntimeConnectionRole = 'owner' | 'user' | 'service';

/**
 * data     — sessions, inputs, Runs, interactions, views, history, read-only catalogs
 * settings — the person's own Host settings (MCP, extensions, providers, config); a platform may lock items
 * trusted  — leases and execution authorization a backend supplies for a person
 * local    — Host start/stop, logs, client exit, diagnostics, memory and learning
 */
export type RuntimeMethodPlane = 'data' | 'settings' | 'trusted' | 'local';

const ROLE_PLANES: Readonly<Record<RuntimeConnectionRole, ReadonlySet<RuntimeMethodPlane>>> = {
  owner: new Set<RuntimeMethodPlane>(['data', 'settings', 'trusted', 'local']),
  user: new Set<RuntimeMethodPlane>(['data', 'settings']),
  service: new Set<RuntimeMethodPlane>(['data', 'trusted']),
};

/** Whether a role reaches a plane. An absent or unknown role reaches none. */
export function runtimeRoleHasPlane(role: RuntimeConnectionRole | undefined, plane: RuntimeMethodPlane): boolean {
  return role !== undefined && Object.hasOwn(ROLE_PLANES, role) && ROLE_PLANES[role].has(plane);
}

// A registration's credentialEnv sends any variable of the Host's environment, as a Bearer token, to the address it names.
const REGISTRATION_REFUSAL = "External Agent registrations stay with the owner on the Host's machine.";

/** Methods a role may not call although it reaches their plane, each with why. */
const ROLE_REFUSALS: Readonly<Record<RuntimeConnectionRole, Readonly<Record<string, string>>>> = {
  owner: {},
  user: Object.fromEntries([
    'agentRegistrations.list', 'agentRegistrations.upsert', 'agentRegistrations.setEnabled', 'agentRegistrations.remove',
    'agent.registration.list', 'agent.registration.upsert', 'agent.registration.setEnabled', 'agent.registration.remove',
  ].map(method => [method, REGISTRATION_REFUSAL])),
  service: {
    'interaction.respond': 'A service connection cannot answer an approval or question addressed to the person.',
  },
};

/**
 * Why a role may not call a method of a plane it reaches, or `undefined`.
 * Both protocols read it, so what a connection is offered matches what it may call.
 */
export function runtimeRoleRefusal(role: RuntimeConnectionRole, method: string): string | undefined {
  return Object.hasOwn(ROLE_REFUSALS[role], method) ? ROLE_REFUSALS[role][method] : undefined;
}

/** Parameters that carry Host-trusted authority. Only roles with the trusted plane may send them. */
const TRUSTED_PARAMS = ['authorization', 'credential', 'hostTools', 'policy', 'runOptions'] as const;

/**
 * One plane per method. `Record<RuntimeDaemonMethod, …>` makes a new method a
 * compile error until it is placed, so nothing is reachable by default.
 */
export const RUNTIME_METHOD_PLANES = {
  // Connection and sync
  'initialize': 'data',
  'runtime.initialize': 'data',
  'ping': 'data',
  'runtime.identity': 'data',
  'runtime.status': 'data',
  'runtime.capabilities': 'data',
  'request.cancel': 'data',
  'request.ack': 'data',
  'subscription.close': 'data',
  // Sessions
  'session.create': 'data',
  'session.load': 'data',
  'session.list': 'data',
  'session.status': 'data',
  'session.observe': 'data',
  'session.view.observe': 'data',
  'session.view.close': 'data',
  'session.view.item': 'data',
  'session.side.open': 'data',
  'session.fork': 'data',
  'session.recover': 'data',
  'session.notice.append': 'data',
  'session.goal.get': 'data',
  'session.goal.create': 'data',
  'session.goal.pause': 'data',
  'session.goal.resume': 'data',
  'session.goal.clear': 'data',
  'session.lineage.get': 'data',
  'session.lineage.label': 'data',
  'session.rewind': 'data',
  'session.active_entry.set': 'data',
  'session.activeEntry.set': 'data',
  'session.compact': 'data',
  'session.archive': 'data',
  'session.unarchive': 'data',
  'session.cancel': 'data',
  'session.delete': 'data',
  'session.settings.get': 'data',
  'session.settings.getVersioned': 'data',
  'session.settings.update': 'data',
  'session.settings.updateVersioned': 'data',
  'session.autoMode.getStats': 'data',
  // History
  'session.transcript': 'data',
  'session.transcript.page': 'data',
  'session.transcript.entryChunk': 'data',
  'session.transcript.search': 'data',
  'session.conversation': 'data',
  'session.conversation.page': 'data',
  'session.conversation.entryChunk': 'data',
  'session.history.resolveTurn': 'data',
  // Inputs and Runs
  'input.submit': 'data',
  'input.withdraw': 'data',
  'input.read': 'data',
  'run.start': 'data',
  'run.recover': 'data',
  'run.input.submit': 'data',
  'run.get': 'data',
  'run.list': 'data',
  'run.await': 'data',
  'run.abort': 'data',
  'run.model.set': 'data',
  'run.provider.set': 'data',
  'run.reasoning.set': 'data',
  'run.setModel': 'data',
  'run.setProvider': 'data',
  'run.setReasoning': 'data',
  // Interactions and grants
  'interaction.list': 'data',
  'interaction.respond': 'data',
  'permission.grants.list': 'data',
  'permission.grants.revoke': 'data',
  // Attachments
  'artifact.create': 'data',
  'artifact.get': 'data',
  'artifact.delete': 'data',
  // Read-only catalogs and statistics
  'agents.listDispatchable': 'data',
  'agents.describe': 'data',
  'command.list': 'data',
  'command.resolve': 'data',
  'skill.list': 'data',
  'skill.describe': 'data',
  'skill.read': 'data',
  'agent.list': 'data',
  'tool.catalog': 'data',
  'model.list': 'data',
  'provider.list': 'data',
  'provider.reasoning.efforts': 'data',
  'mcp.tool.list': 'data',
  'session.facts.read': 'data',
  'session.facts.requests': 'data',
  'session.facts.tools': 'data',
  // Commands and reviews
  'invocations.prepareSkill': 'data',
  'invocations.prepareCommand': 'data',
  'invocations.readCommandPrompt': 'data',
  'invocations.executeCommand': 'data',
  'invocations.prepareReview': 'data',
  'invocations.startReview': 'data',
  'invocations.prepareAgentsLean': 'data',
  'invocations.startAgentsLean': 'data',
  // Running sub-agents
  'agents.preflight': 'data',
  'agents.tree': 'data',
  'agents.detail': 'data',
  'agents.spawn': 'data',
  'agents.send': 'data',
  'agents.followup': 'data',
  'agents.interrupt': 'data',
  'agents.output': 'data',
  'agents.events': 'data',
  'agents.wait': 'data',
  // Workflows
  'workflow.list': 'data',
  'workflow.get': 'data',
  'workflow.subscribe': 'data',
  'workflow.unsubscribe': 'data',
  'workflow.start': 'data',
  'workflow.pause': 'data',
  'workflow.resume': 'data',
  'workflow.stop': 'data',

  // User settings
  'config.read': 'settings',
  'config.effective': 'settings',
  'config.patch': 'settings',
  'config.reload': 'settings',
  'provider.reasoning.probe': 'settings',
  'provider.capabilities.forget': 'settings',
  'provider.custom.list': 'settings',
  'provider.custom.upsert': 'settings',
  'provider.custom.remove': 'settings',
  'mcp.server.list': 'settings',
  'mcp.server.status': 'settings',
  'mcp.server.get': 'settings',
  'mcp.server.validate': 'settings',
  'mcp.server.upsert': 'settings',
  'mcp.server.delete': 'settings',
  'mcp.server.remove': 'settings',
  'mcp.server.reload': 'settings',
  'extension.list': 'settings',
  'extension.reload': 'settings',
  'agentRegistrations.list': 'settings',
  'agentRegistrations.upsert': 'settings',
  'agentRegistrations.setEnabled': 'settings',
  'agentRegistrations.remove': 'settings',

  // Trusted: leases, execution authorization, promotion
  'execution.register': 'trusted',
  'execution.revoke': 'trusted',
  'execution.complete': 'trusted',
  'credential.register': 'trusted',
  'credential.get': 'trusted',
  'credential.revoke': 'trusted',
  'credential.supply': 'trusted',
  'host_tool.register': 'trusted',
  'host_tool.get': 'trusted',
  'host_tool.invocation.get': 'trusted',
  'host_tool.revoke': 'trusted',
  'host_tool.complete': 'trusted',
  'session.promote': 'trusted',
  'session.policy.update': 'trusted',
  'session.promotion.read': 'trusted',

  // Local management
  'runtime.shutdown': 'local',
  'daemon.status': 'local',
  'daemon.stop': 'local',
  'daemon.logs': 'local',
  'daemon.preflight': 'local',
  'daemon.management.get': 'local',
  'daemon.integrations.get': 'local',
  'client.exit.request': 'local',
  'client.exit.read': 'local',
  'client.exit.pending': 'local',
  'session.diagnostics': 'local',
  'session.identityAlias.confirm': 'local',
  'repo.intelligence.inspect': 'local',
  'repo.intelligence.prewarm': 'local',
  // Memory and skill learning stay with the local owner until their models are redefined.
  'memory.describe': 'local',
  'memory.listReviews': 'local',
  'memory.listInbox': 'local',
  'memory.showProposal': 'local',
  'memory.listRefs': 'local',
  'memory.readRef': 'local',
  'memory.remember': 'local',
  'memory.forgetRef': 'local',
  'memory.approveProposal': 'local',
  'memory.rejectProposal': 'local',
  'memory.rebuild': 'local',
  'memory.ensureOpenTarget': 'local',
  // Any client governs what the Host learned; its subscription moves to the Host's view.
  'learning.list': 'data',
  'learning.get': 'data',
  'learning.snapshot': 'data',
  'learning.events': 'data',
  'learning.subscribe': 'local',
  'learning.unsubscribe': 'local',
  'learning.acknowledge': 'data',
  'learning.snooze': 'data',
  'learning.reject': 'data',
  'learning.disable': 'data',
  'learning.rollback': 'data',
  'learning.promote': 'data',
  'learning.review': 'data',
  'learning.trust': 'data',
} as const satisfies Record<RuntimeDaemonMethod, RuntimeMethodPlane>;

/**
 * Why this role may not make this call, or `undefined` when it may.
 * Deny by default: an absent or unknown role is refused for every method.
 */
export function runtimeAccessDenial(
  role: RuntimeConnectionRole | undefined,
  method: RuntimeDaemonMethod,
  params: unknown,
): string | undefined {
  if (role === undefined || !Object.hasOwn(ROLE_PLANES, role)) {
    return 'This connection has no role, so the Host accepts no method from it.';
  }
  const plane: RuntimeMethodPlane | undefined = Object.hasOwn(RUNTIME_METHOD_PLANES, method)
    ? RUNTIME_METHOD_PLANES[method] : undefined;
  if (plane === undefined || !runtimeRoleHasPlane(role, plane)) return `${method} is not available to the ${role} role.`;
  const refusal = runtimeRoleRefusal(role, method);
  if (refusal !== undefined) return refusal;
  if (!runtimeRoleHasPlane(role, 'trusted')) {
    const sent = trustedParamIn(params);
    if (sent !== undefined) return `The ${role} role cannot send the trusted parameter "${sent}".`;
  }
  return undefined;
}

/** The trusted parameters a call sends, empty for a trusted method sent without any; undefined when it uses no trusted authority. */
export function runtimeTrustedUse(method: RuntimeDaemonMethod, params: unknown): readonly string[] | undefined {
  const record = typeof params === 'object' && params !== null ? params as Record<string, unknown> : {};
  const sent = TRUSTED_PARAMS.filter(name => record[name] !== undefined);
  const trustedMethod = Object.hasOwn(RUNTIME_METHOD_PLANES, method) && RUNTIME_METHOD_PLANES[method] === 'trusted';
  return sent.length > 0 || trustedMethod ? sent : undefined;
}

function trustedParamIn(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const record = params as Record<string, unknown>;
  return TRUSTED_PARAMS.find(name => record[name] !== undefined);
}

/**
 * Who a connection acts for. Every human connection to a Host is the one person
 * it belongs to; a backend service is named by its verified token subject. A
 * service without one has no identity, so the caller must refuse it.
 */
export function runtimeAuthorizationSubject(
  role: RuntimeConnectionRole | undefined,
  tokenSubject: string | undefined,
): string | undefined {
  if (role === 'owner' || role === 'user') return 'person';
  if (role === 'service' && tokenSubject) return `service:${tokenSubject}`;
  return undefined;
}
