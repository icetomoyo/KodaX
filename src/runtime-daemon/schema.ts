import type { AgentSpawnInput } from '@kodax-ai/agent';

import {
  KODAX_DAEMON_PROTOCOL,
  KODAX_DAEMON_PROTOCOL_VERSION,
  RUNTIME_DAEMON_METHODS,
  type RuntimeDaemonMethod,
  type RuntimeDaemonNotificationMethod,
} from './protocol.js';

export type RuntimeDaemonJsonSchemaType =
  | 'array'
  | 'boolean'
  | 'integer'
  | 'null'
  | 'number'
  | 'object'
  | 'string';

export interface RuntimeDaemonJsonSchema {
  readonly type?: RuntimeDaemonJsonSchemaType | readonly RuntimeDaemonJsonSchemaType[];
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly properties?: Record<string, RuntimeDaemonJsonSchema>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | RuntimeDaemonJsonSchema;
  readonly items?: RuntimeDaemonJsonSchema;
  readonly oneOf?: readonly RuntimeDaemonJsonSchema[];
  readonly maxLength?: number;
  readonly maximum?: number;
  readonly minimum?: number;
}

export interface RuntimeDaemonMethodSchema {
  readonly params: RuntimeDaemonJsonSchema;
  readonly result: RuntimeDaemonJsonSchema;
}

export interface RuntimeDaemonProtocolSchema {
  readonly protocol: typeof KODAX_DAEMON_PROTOCOL;
  readonly version: typeof KODAX_DAEMON_PROTOCOL_VERSION;
  readonly methods: Record<RuntimeDaemonMethod, RuntimeDaemonMethodSchema>;
  readonly notifications: Record<RuntimeDaemonNotificationMethod, RuntimeDaemonJsonSchema>;
}

const stringSchema: RuntimeDaemonJsonSchema = { type: 'string' };
const booleanSchema: RuntimeDaemonJsonSchema = { type: 'boolean' };
const integerSchema: RuntimeDaemonJsonSchema = { type: 'integer' };
const objectAnySchema: RuntimeDaemonJsonSchema = { type: 'object', additionalProperties: true };
const anyValueSchema: RuntimeDaemonJsonSchema = {};
const arrayAnySchema: RuntimeDaemonJsonSchema = { type: 'array', items: objectAnySchema };
const nullOrObjectSchema: RuntimeDaemonJsonSchema = {
  oneOf: [{ type: 'null' }, objectAnySchema],
};
const okSchema = objectSchema({ ok: booleanSchema }, ['ok']);
const noParamsSchema = objectSchema({});

export const RUNTIME_DAEMON_METHOD_SCHEMAS = {
  initialize: {
    params: objectSchema({
      profile: stringSchema,
      token: stringSchema,
      autoStart: booleanSchema,
      endpoint: stringSchema,
      connectionPurpose: { type: 'string', enum: ['client', 'probe'] },
      clientInfo: objectAnySchema,
      capabilities: objectAnySchema,
    }, [], true),
    result: objectSchema({
      identity: objectAnySchema,
      capabilities: objectAnySchema,
    }, ['identity', 'capabilities'], true),
  },
  'runtime.initialize': {
    params: objectSchema({
      profile: stringSchema,
      token: stringSchema,
      autoStart: booleanSchema,
      endpoint: stringSchema,
      connectionPurpose: { type: 'string', enum: ['client', 'probe'] },
      clientInfo: objectAnySchema,
      capabilities: objectAnySchema,
    }, [], true),
    result: objectSchema({
      identity: objectAnySchema,
      capabilities: objectAnySchema,
    }, ['identity', 'capabilities'], true),
  },
  ping: {
    params: noParamsSchema,
    result: objectSchema({ ok: booleanSchema, runtimeId: stringSchema }, ['ok', 'runtimeId']),
  },
  'runtime.identity': { params: noParamsSchema, result: objectAnySchema },
  'runtime.status': { params: noParamsSchema, result: objectAnySchema },
  'runtime.shutdown': { params: noParamsSchema, result: okSchema },
  'runtime.capabilities': { params: noParamsSchema, result: objectAnySchema },
  'daemon.status': { params: noParamsSchema, result: objectAnySchema },
  'daemon.stop': { params: noParamsSchema, result: okSchema },
  'daemon.logs': { params: noParamsSchema, result: objectAnySchema },
  'daemon.preflight': { params: noParamsSchema, result: objectAnySchema },
  'daemon.management.get': {
    params: noParamsSchema,
    result: objectSchema({
      runtimeId: stringSchema,
      revision: integerSchema,
      ownerPolicy: ownerPolicySchema(),
      owner: ownerIdentitySchema(),
      preflight: objectAnySchema,
      integrations: integrationHealthSchema(),
    }, ['runtimeId', 'revision', 'ownerPolicy', 'owner', 'preflight']),
  },
  'daemon.rollbackToInline': {
    params: objectSchema({
      expectedRuntimeId: stringSchema,
      expectedRevision: integerSchema,
      expectedOwnerPolicyRevision: integerSchema,
    }, ['expectedRuntimeId', 'expectedRevision', 'expectedOwnerPolicyRevision']),
    result: objectSchema({
      accepted: { type: 'boolean', enum: [true] },
      runtimeId: stringSchema,
      revision: integerSchema,
      ownerPolicy: ownerPolicySchema('inline'),
    }, ['accepted', 'runtimeId', 'revision', 'ownerPolicy']),
  },
  'operation.get': {
    params: objectSchema({
      operationId: stringSchema,
      journalEpoch: stringSchema,
    }, ['operationId', 'journalEpoch']),
    result: objectAnySchema,
  },

  'session.create': { params: createSessionParamsSchema(), result: sessionSchema() },
  'session.load': {
    params: objectSchema({
      sessionId: stringSchema,
      timeoutMs: integerSchema,
    }, ['sessionId']),
    result: sessionSchema(),
  },
  'session.list': { params: sessionFilterSchema(), result: arraySchema(sessionSchema()) },
  'session.status': {
    params: objectSchema({ sessionId: stringSchema }, ['sessionId']),
    result: objectAnySchema,
  },
  'session.transcript': {
    params: objectSchema({
      sessionId: stringSchema,
      timeoutMs: integerSchema,
    }, ['sessionId']),
    result: nullOrObjectSchema,
  },
  'session.transcript.page': {
    params: objectSchema({
      sessionId: stringSchema,
      cursor: stringSchema,
      limit: integerSchema,
      timeoutMs: integerSchema,
    }, ['sessionId']),
    result: nullOrObjectSchema,
  },
  'session.transcript.entryChunk': {
    params: objectSchema({
      sessionId: stringSchema,
      revision: stringSchema,
      entryIndex: integerSchema,
      cursor: stringSchema,
      timeoutMs: integerSchema,
    }, ['sessionId', 'revision', 'entryIndex']),
    result: nullOrObjectSchema,
  },
  'session.transcript.search': {
    params: transcriptSearchParamsSchema(),
    result: nullableSchema(transcriptSearchResultSchema()),
  },
  'session.observe': {
    params: objectSchema({
      sessionId: stringSchema,
      timeoutMs: integerSchema,
    }, ['sessionId']),
    result: objectAnySchema,
  },
  'session.conversation': {
    params: objectSchema({
      sessionId: stringSchema,
      timeoutMs: integerSchema,
    }, ['sessionId']),
    result: nullOrObjectSchema,
  },
  'session.conversation.page': {
    params: objectSchema({
      sessionId: stringSchema,
      cursor: stringSchema,
      limit: integerSchema,
      timeoutMs: integerSchema,
    }, ['sessionId']),
    result: nullOrObjectSchema,
  },
  'session.conversation.entryChunk': {
    params: objectSchema({
      sessionId: stringSchema,
      revision: stringSchema,
      entryIndex: integerSchema,
      cursor: stringSchema,
      timeoutMs: integerSchema,
    }, ['sessionId', 'revision', 'entryIndex']),
    result: nullOrObjectSchema,
  },
  'session.diagnostics': {
    params: objectSchema({
      sessionId: stringSchema,
      runId: stringSchema,
      timeoutMs: integerSchema,
    }, ['sessionId']),
    result: sessionDiagnosticsSchema(),
  },
  'session.fork': { params: forkSessionParamsSchema(), result: nullableSchema(sessionSchema()) },
  'session.notice.append': {
    params: objectSchema({
      sessionId: stringSchema,
      content: stringSchema,
      source: stringSchema,
    }, ['sessionId', 'content']),
    result: nullOrObjectSchema,
  },
  'session.rewind': {
    params: objectSchema({
      sessionId: stringSchema,
      selector: stringSchema,
      historyBoundary: conversationHistoryBoundarySchema(),
    }, ['sessionId']),
    result: nullableSchema(sessionSchema()),
  },
  'session.active_entry.set': {
    params: activeEntryParamsSchema(),
    result: nullableSchema(sessionSchema()),
  },
  'session.activeEntry.set': {
    params: activeEntryParamsSchema(),
    result: nullableSchema(sessionSchema()),
  },
  'session.compact': { params: compactSessionParamsSchema(), result: objectAnySchema },
  'session.archive': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: okSchema },
  'session.unarchive': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: okSchema },
  'session.delete': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: okSchema },
  'session.settings.get': { params: objectSchema({ sessionId: stringSchema }, ['sessionId']), result: objectAnySchema },
  'session.settings.getVersioned': {
    params: objectSchema({ sessionId: stringSchema }, ['sessionId']),
    result: objectAnySchema,
  },
  'session.autoMode.getStats': {
    params: objectSchema({ sessionId: stringSchema }, ['sessionId']),
    result: nullableSchema(objectAnySchema),
  },
  'session.settings.update': {
    params: objectSchema({
      sessionId: stringSchema,
      patch: objectAnySchema,
    }, ['sessionId', 'patch']),
    result: objectAnySchema,
  },
  'session.settings.updateVersioned': {
    params: objectSchema({
      sessionId: stringSchema,
      patch: objectAnySchema,
      expectedRevision: integerSchema,
    }, ['sessionId', 'patch', 'expectedRevision']),
    result: objectAnySchema,
  },

  'run.start': { params: startRunParamsSchema(), result: runStartedSchema() },
  'run.input.submit': {
    params: objectSchema({
      sessionId: stringSchema,
      afterRunId: stringSchema,
      delivery: { type: 'string', enum: ['after_turn', 'interrupt'] },
      input: anyValueSchema,
      credential: credentialBindingSchema(),
      hostTools: objectSchema({ leaseId: stringSchema }, ['leaseId']),
    }, ['sessionId', 'afterRunId', 'delivery', 'input']),
    result: objectAnySchema,
  },
  'run.get': { params: runIdParamsSchema(), result: runStatusSchema() },
  'run.list': { params: runFilterSchema(), result: arraySchema(runStatusSchema()) },
  'run.await': { params: runIdParamsSchema(), result: runResultSchema() },
  'run.abort': { params: runIdParamsSchema(), result: runStopReceiptSchema() },
  'run.model.set': {
    params: objectSchema({ runId: stringSchema, model: stringSchema }, ['runId'], true),
    result: okSchema,
  },
  'run.provider.set': {
    params: objectSchema({ runId: stringSchema, provider: stringSchema }, ['runId', 'provider']),
    result: okSchema,
  },
  'run.reasoning.set': {
    params: objectSchema({ runId: stringSchema, reasoning: stringSchema }, ['runId'], true),
    result: okSchema,
  },
  'run.setModel': {
    params: objectSchema({ runId: stringSchema, model: stringSchema }, ['runId'], true),
    result: okSchema,
  },
  'run.setProvider': {
    params: objectSchema({ runId: stringSchema, provider: stringSchema }, ['runId', 'provider']),
    result: okSchema,
  },
  'run.setReasoning': {
    params: objectSchema({ runId: stringSchema, reasoning: stringSchema }, ['runId'], true),
    result: okSchema,
  },

  'request.cancel': {
    params: objectSchema({ requestId: stringSchema }, ['requestId']),
    result: okSchema,
  },
  'request.ack': {
    params: objectSchema({ requestId: stringSchema }, ['requestId']),
    result: okSchema,
  },
  'event.subscribe': { params: filterParamsSchema(eventFilterSchema(), true), result: subscriptionSchema() },
  'event.unsubscribe': {
    params: objectSchema({ subscriptionId: stringSchema }, ['subscriptionId']),
    result: okSchema,
  },
  'event.replay': { params: eventReplayFilterSchema(), result: arraySchema(runtimeEventSchema()) },

  'permission.list': { params: permissionFilterSchema(), result: arraySchema(permissionRequestSchema()) },
  'permission.listPending': { params: permissionFilterSchema(), result: arraySchema(permissionRequestSchema()) },
  'permission.request': { params: permissionRequestInputSchema(), result: permissionDecisionSchema() },
  'permission.respond': {
    params: objectSchema({
      requestId: stringSchema,
      runId: stringSchema,
      decision: permissionDecisionSchema(),
    }, ['requestId', 'decision']),
    result: booleanSchema,
  },
  'permission.grants.list': { params: noParamsSchema, result: objectAnySchema },
  'permission.grants.revoke': {
    params: objectSchema({ grantId: stringSchema, expectedRevision: integerSchema }, ['grantId', 'expectedRevision']),
    result: booleanSchema,
  },
  'user_input.listPending': { params: permissionFilterSchema(), result: arraySchema(objectAnySchema) },
  'user_input.respond': {
    params: objectSchema({
      requestId: stringSchema,
      answer: anyValueSchema,
      runId: stringSchema,
      expectedRevision: integerSchema,
    }, ['requestId', 'answer'], true),
    result: objectAnySchema,
  },
  'user_input.dismiss': {
    params: objectSchema({
      requestId: stringSchema,
      runId: stringSchema,
      expectedRevision: integerSchema,
    }, ['requestId'], true),
    result: objectAnySchema,
  },
  'credential.register': {
    params: objectSchema({
      leaseId: stringSchema,
      providers: { type: 'array', items: stringSchema },
      expiresAt: stringSchema,
      brokerVersion: { type: 'integer', enum: [1, 2] },
    }, ['leaseId', 'providers'], true),
    result: objectAnySchema,
  },
  'credential.get': {
    params: objectSchema({ leaseId: stringSchema }, ['leaseId']),
    result: { oneOf: [objectAnySchema, { type: 'null' }] },
  },
  'credential.revoke': {
    params: objectSchema({ leaseId: stringSchema }, ['leaseId']),
    result: booleanSchema,
  },
  'credential.supply': {
    params: objectSchema({ requestId: stringSchema, credential: stringSchema, error: stringSchema }, ['requestId'], true),
    result: okSchema,
  },
  'host_tool.register': {
    params: objectSchema({
      leaseId: stringSchema,
      tools: { type: 'array', items: objectAnySchema },
    }, ['leaseId', 'tools']),
    result: objectAnySchema,
  },
  'host_tool.get': {
    params: objectSchema({ leaseId: stringSchema }, ['leaseId']),
    result: { oneOf: [objectAnySchema, { type: 'null' }] },
  },
  'host_tool.invocation.get': {
    params: objectSchema({ invocationId: stringSchema }, ['invocationId']),
    result: { oneOf: [objectAnySchema, { type: 'null' }] },
  },
  'host_tool.revoke': {
    params: objectSchema({ leaseId: stringSchema }, ['leaseId']),
    result: booleanSchema,
  },
  'host_tool.complete': {
    params: objectSchema({
      invocationId: stringSchema,
      result: objectAnySchema,
      error: stringSchema,
    }, ['invocationId'], true),
    result: okSchema,
  },

  'workflow.list': { params: workflowFilterSchema(), result: arrayAnySchema },
  'workflow.get': { params: runIdParamsSchema(), result: { oneOf: [objectAnySchema, { type: 'null' }] } },
  'workflow.subscribe': { params: filterParamsSchema(workflowFilterSchema()), result: subscriptionSchema() },
  'workflow.unsubscribe': {
    params: objectSchema({ subscriptionId: stringSchema }, ['subscriptionId']),
    result: okSchema,
  },
  'workflow.pause': { params: runIdParamsSchema(), result: booleanSchema },
  'workflow.resume': { params: runIdParamsSchema(), result: booleanSchema },
  'workflow.stop': { params: runIdParamsSchema(), result: booleanSchema },

  'learning.list': { params: learningQuerySchema(), result: learningPageSchema() },
  'learning.get': {
    params: objectSchema({ nameOrSlug: stringSchema }, ['nameOrSlug']),
    result: learnedCapabilitySchema(),
  },
  'learning.snapshot': { params: noParamsSchema, result: learningSnapshotSchema() },
  'learning.events': {
    params: objectSchema({ afterRevision: integerSchema }, [], true),
    result: arraySchema(learningEventSchema()),
  },
  'learning.acknowledge': {
    params: objectSchema({ nameOrSlug: stringSchema }, ['nameOrSlug']),
    result: okSchema,
  },
  'learning.snooze': {
    params: objectSchema({ nameOrSlug: stringSchema, until: stringSchema }, ['nameOrSlug', 'until']),
    result: okSchema,
  },
  'learning.reject': {
    params: objectSchema({ nameOrSlug: stringSchema }, ['nameOrSlug']),
    result: okSchema,
  },
  'learning.disable': {
    params: objectSchema({ nameOrSlug: stringSchema }, ['nameOrSlug']),
    result: okSchema,
  },
  'learning.rollback': {
    params: objectSchema({ nameOrSlug: stringSchema }, ['nameOrSlug']),
    result: okSchema,
  },
  'learning.promote': {
    params: objectSchema({
      nameOrSlug: stringSchema,
      scope: { type: 'string', enum: ['user'] },
    }, ['nameOrSlug', 'scope']),
    result: okSchema,
  },
  'learning.review': {
    params: objectSchema({ nameOrSlug: stringSchema }, ['nameOrSlug']),
    result: okSchema,
  },
  'learning.trust': {
    params: objectSchema({ nameOrSlug: stringSchema }, ['nameOrSlug']),
    result: okSchema,
  },

  'config.read': { params: noParamsSchema, result: objectAnySchema },
  'config.effective': {
    params: noParamsSchema,
    result: effectiveConfigSnapshotSchema(),
  },
  'config.patch': { params: objectSchema({ patch: objectAnySchema }, ['patch']), result: objectAnySchema },
  'config.reload': { params: noParamsSchema, result: objectSchema({ ok: booleanSchema, config: objectAnySchema }, ['ok', 'config']) },
  'model.list': {
    params: objectSchema({ provider: stringSchema }, [], true),
    result: { oneOf: [objectAnySchema, arrayAnySchema] },
  },
  'provider.list': { params: noParamsSchema, result: arrayAnySchema },
  'provider.custom.list': { params: noParamsSchema, result: arrayAnySchema },
  'provider.custom.upsert': {
    params: objectSchema({ config: objectAnySchema }, ['config']),
    result: objectAnySchema,
  },
  'provider.custom.remove': { params: objectSchema({ name: stringSchema }, ['name']), result: booleanSchema },

  'mcp.server.list': { params: noParamsSchema, result: objectAnySchema },
  'mcp.server.get': { params: objectSchema({ name: stringSchema }, ['name']), result: { oneOf: [objectAnySchema, { type: 'null' }] } },
  'mcp.server.validate': {
    params: objectSchema({
      name: stringSchema,
      config: objectAnySchema,
    }, ['name', 'config']),
    result: {
      oneOf: [
        objectSchema({ ok: booleanSchema, config: objectAnySchema }, ['ok', 'config'], true),
        objectSchema({ ok: booleanSchema, error: stringSchema }, ['ok', 'error'], true),
      ],
    },
  },
  'mcp.server.upsert': {
    params: objectSchema({
      name: stringSchema,
      config: objectAnySchema,
    }, ['name', 'config']),
    result: objectAnySchema,
  },
  'mcp.server.delete': { params: objectSchema({ name: stringSchema }, ['name']), result: booleanSchema },
  'mcp.server.remove': { params: objectSchema({ name: stringSchema }, ['name']), result: booleanSchema },
  'mcp.server.reload': { params: noParamsSchema, result: objectSchema({ ok: booleanSchema, servers: arrayAnySchema }, ['ok', 'servers']) },
  'mcp.tool.list': { params: objectSchema({ server: stringSchema, forceRefresh: booleanSchema }, [], true), result: arrayAnySchema },

  'extension.list': {
    params: noParamsSchema,
    result: objectSchema({
      active: booleanSchema,
      extensions: arrayAnySchema,
      diagnostics: objectAnySchema,
    }, ['active', 'extensions'], true),
  },
  'extension.reload': { params: noParamsSchema, result: objectSchema({ ok: booleanSchema, active: booleanSchema }, ['ok', 'active'], true) },
  'command.list': { params: objectSchema({ projectRoot: stringSchema }, [], true), result: arrayAnySchema },
  'command.resolve': { params: objectSchema({ name: stringSchema, projectRoot: stringSchema }, ['name'], true), result: nullOrObjectSchema },
  'skill.list': {
    params: objectSchema({
      projectRoot: stringSchema,
      userInvocableOnly: booleanSchema,
    }, [], true),
    result: arrayAnySchema,
  },
  'skill.describe': { params: objectSchema({ name: stringSchema, projectRoot: stringSchema }, ['name'], true), result: nullOrObjectSchema },
  'skill.read': { params: objectSchema({ name: stringSchema, projectRoot: stringSchema }, ['name'], true), result: nullOrObjectSchema },

  'artifact.create': {
    params: objectSchema({
      kind: { enum: ['image', 'file', 'video'] },
      path: stringSchema,
      mediaType: stringSchema,
      mimeType: stringSchema,
      name: stringSchema,
      source: { enum: ['user-inline', 'clipboard', 'drag-drop', 'file-picker'] },
      description: stringSchema,
    }, ['kind', 'path']),
    result: artifactSchema(),
  },
  'artifact.get': {
    params: objectSchema({ artifactId: stringSchema }, ['artifactId']),
    result: nullableSchema(artifactSchema()),
  },
  'artifact.delete': { params: objectSchema({ artifactId: stringSchema }, ['artifactId']), result: booleanSchema },

  'agentRegistrations.list': { params: noParamsSchema, result: arrayAnySchema },
  'agentRegistrations.upsert': {
    params: objectSchema({
      registration: objectAnySchema,
      expectedConfigurationRevision: nullableSchema(stringSchema),
      expectedManagementOwner: nullableSchema(stringSchema),
    }, ['registration']),
    result: objectAnySchema,
  },
  'agentRegistrations.setEnabled': {
    params: objectSchema({
      agentId: stringSchema,
      enabled: booleanSchema,
      expectedConfigurationRevision: nullableSchema(stringSchema),
      expectedManagementOwner: nullableSchema(stringSchema),
      claimOwner: stringSchema,
    }, ['agentId', 'enabled']),
    result: nullableSchema(objectAnySchema),
  },
  'agentRegistrations.remove': {
    params: objectSchema({
      agentId: stringSchema,
      expectedConfigurationRevision: nullableSchema(stringSchema),
      expectedManagementOwner: nullableSchema(stringSchema),
    }, ['agentId']),
    result: booleanSchema,
  },
  'agents.listDispatchable': { params: objectAnySchema, result: arrayAnySchema },
  'agents.describe': {
    params: objectSchema({ agentId: stringSchema, query: objectAnySchema }, ['agentId', 'query']),
    result: nullableSchema(objectAnySchema),
  },
  'agents.preflight': { params: objectAnySchema, result: objectAnySchema },
  'agents.tree': {
    params: objectSchema({ sessionId: stringSchema }, ['sessionId']),
    result: objectAnySchema,
  },
  'agents.detail': {
    params: objectSchema({ sessionId: stringSchema, actorPath: stringSchema }, ['sessionId', 'actorPath']),
    result: objectAnySchema,
  },
  'agents.spawn': {
    params: objectSchema({
      sessionId: stringSchema,
      input: agentSpawnInputSchema(),
      credential: credentialBindingSchema(),
    }, ['sessionId', 'input']),
    result: objectAnySchema,
  },
  'agents.send': {
    params: objectSchema({
      sessionId: stringSchema,
      actorPath: stringSchema,
      content: stringSchema,
      classification: { enum: ['public', 'internal', 'sensitive'] },
    }, ['sessionId', 'actorPath', 'content'], true),
    result: okSchema,
  },
  'agents.followup': {
    params: objectSchema({
      sessionId: stringSchema,
      actorPath: stringSchema,
      objective: stringSchema,
      expectedRevision: integerSchema,
      credential: credentialBindingSchema(),
    }, ['sessionId', 'actorPath', 'objective']),
    result: objectAnySchema,
  },
  'agents.interrupt': {
    params: objectSchema({
      sessionId: stringSchema, actorPath: stringSchema, reason: stringSchema,
    }, ['sessionId', 'actorPath'], true),
    result: okSchema,
  },
  'agents.output': {
    params: objectSchema({
      sessionId: stringSchema, actorPath: stringSchema, turnId: stringSchema,
    }, ['sessionId', 'actorPath'], true),
    result: objectAnySchema,
  },
  'agents.events': {
    params: objectSchema({
      sessionId: stringSchema, afterSequence: integerSchema,
    }, ['sessionId'], true),
    result: arrayAnySchema,
  },
  'agents.wait': {
    params: objectSchema({
      sessionId: stringSchema, afterSequence: integerSchema, timeoutMs: integerSchema,
    }, ['sessionId'], true),
    result: nullableSchema(objectAnySchema),
  },
  'context.budget.get': { params: diagnosticParamsSchema(), result: { oneOf: [objectAnySchema, { type: 'null' }] } },
  'tool.exposure.preview': { params: diagnosticParamsSchema(), result: { oneOf: [objectAnySchema, { type: 'null' }] } },
  'provider.cache.diagnostics.get': {
    params: diagnosticParamsSchema(),
    result: { oneOf: [objectAnySchema, { type: 'null' }] },
  },
} satisfies Record<RuntimeDaemonMethod, RuntimeDaemonMethodSchema>;

export const RUNTIME_DAEMON_NOTIFICATION_SCHEMAS = {
  event: objectSchema({ subscriptionId: stringSchema, event: objectAnySchema }, ['subscriptionId', 'event']),
  'observation.invalidated': objectSchema({
    subscriptionId: stringSchema,
    sessionId: stringSchema,
    invalidation: objectSchema({
      code: { type: 'string', enum: ['observation_invalidated'] },
      reason: {
        type: 'string',
        enum: [
          'event_overflow',
          'event_order',
          'delivery_failed',
          'runtime_changed',
          'transport_disconnected',
        ],
      },
      runtimeId: stringSchema,
      message: stringSchema,
    }, ['code', 'reason', 'runtimeId', 'message']),
  }, ['subscriptionId', 'invalidation']),
  'credential.request': objectAnySchema,
  'host_tool.invoke': objectAnySchema,
  'runtime.warning': objectAnySchema,
} satisfies Record<RuntimeDaemonNotificationMethod, RuntimeDaemonJsonSchema>;

export const RUNTIME_DAEMON_PROTOCOL_SCHEMA: RuntimeDaemonProtocolSchema = {
  protocol: KODAX_DAEMON_PROTOCOL,
  version: KODAX_DAEMON_PROTOCOL_VERSION,
  methods: RUNTIME_DAEMON_METHOD_SCHEMAS,
  notifications: RUNTIME_DAEMON_NOTIFICATION_SCHEMAS,
};

export const RUNTIME_DAEMON_PROTOCOL_SCHEMA_JSON = JSON.stringify(
  RUNTIME_DAEMON_PROTOCOL_SCHEMA,
  null,
  2,
);

export function listRuntimeDaemonSchemaMethods(): readonly RuntimeDaemonMethod[] {
  return RUNTIME_DAEMON_METHODS;
}

export function validateRuntimeDaemonJsonSchema(
  schema: RuntimeDaemonJsonSchema,
  value: unknown,
  path = '$',
): readonly string[] {
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((candidate) => (
      validateRuntimeDaemonJsonSchema(candidate, value, path).length === 0
    ));
    return matches.length === 1
      ? []
      : [`${path} must match exactly one allowed schema.`];
  }

  if (schema.enum !== undefined && !schema.enum.some((item) => Object.is(item, value))) {
    return [`${path} must be one of: ${schema.enum.map(String).join(', ')}.`];
  }

  const types = schema.type === undefined
    ? []
    : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((type) => matchesJsonSchemaType(type, value))) {
    return [`${path} must be ${types.join(' or ')}.`];
  }

  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) {
    return [`${path} must have at most ${schema.maxLength} characters.`];
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    return [`${path} must be at least ${schema.minimum}.`];
  }
  if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) {
    return [`${path} must be at most ${schema.maximum}.`];
  }

  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    if (itemSchema === undefined) return [];
    return value.flatMap((item, index) => (
      validateRuntimeDaemonJsonSchema(itemSchema, item, `${path}[${index}]`)
    ));
  }

  if (!isJsonObject(value)) return [];
  const issues: string[] = [];
  for (const key of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
      issues.push(`${path}.${key} is required.`);
    }
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const propertySchema = schema.properties?.[key];
    if (propertySchema !== undefined) {
      issues.push(...validateRuntimeDaemonJsonSchema(propertySchema, item, `${path}.${key}`));
      continue;
    }
    if (schema.additionalProperties === false) {
      issues.push(`${path}.${key} is not allowed.`);
    } else if (typeof schema.additionalProperties === 'object') {
      issues.push(...validateRuntimeDaemonJsonSchema(
        schema.additionalProperties,
        item,
        `${path}.${key}`,
      ));
    }
  }
  return issues;
}

function matchesJsonSchemaType(type: RuntimeDaemonJsonSchemaType, value: unknown): boolean {
  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'null':
      return value === null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return isJsonObject(value);
    case 'string':
      return typeof value === 'string';
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integrationHealthSchema(): RuntimeDaemonJsonSchema {
  const diagnostic = objectSchema({
    code: {
      type: 'string',
      enum: ['invalid-config', 'activation-failed', 'watcher-degraded'],
    },
    message: stringSchema,
    time: stringSchema,
  }, ['code', 'message', 'time']);
  const domain = objectSchema({
    domain: { type: 'string', enum: ['mcp', 'a2a', 'extensions'] },
    path: stringSchema,
    revision: stringSchema,
    source: { type: 'string', enum: ['user', 'legacy-user', 'default'] },
    lastReloadAt: stringSchema,
    diagnostic,
    watching: booleanSchema,
  }, ['domain', 'path', 'watching']);
  return objectSchema({
    state: { type: 'string', enum: ['healthy', 'degraded'] },
    domains: { type: 'array', items: domain },
  }, ['state', 'domains']);
}

function objectSchema(
  properties: Record<string, RuntimeDaemonJsonSchema>,
  required: readonly string[] = [],
  additionalProperties: boolean | RuntimeDaemonJsonSchema = false,
): RuntimeDaemonJsonSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties,
  };
}

function runIdParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({ runId: stringSchema }, ['runId']);
}

function filterParamsSchema(
  filter: RuntimeDaemonJsonSchema,
  required = false,
): RuntimeDaemonJsonSchema {
  return objectSchema({ filter }, required ? ['filter'] : []);
}

function diagnosticParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    runId: stringSchema,
    contextKind: { type: 'string', enum: ['root', 'child'] },
    agentId: stringSchema,
  }, [], true);
}

function subscriptionSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({ subscriptionId: stringSchema }, ['subscriptionId']);
}

function runStartedSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    runId: stringSchema,
    sessionId: stringSchema,
    turnId: stringSchema,
  }, ['runId', 'sessionId'], true);
}

function arraySchema(items: RuntimeDaemonJsonSchema): RuntimeDaemonJsonSchema {
  return { type: 'array', items };
}

function nullableSchema(schema: RuntimeDaemonJsonSchema): RuntimeDaemonJsonSchema {
  return { oneOf: [{ type: 'null' }, schema] };
}

function transcriptSearchParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    query: stringSchema,
    limit: integerSchema,
    role: { type: 'string', enum: ['user', 'assistant'] },
    scope: { type: 'string', enum: ['compacted', 'all'] },
    timeoutMs: integerSchema,
  }, ['sessionId', 'query']);
}

function transcriptSearchResultSchema(): RuntimeDaemonJsonSchema {
  const hit = objectSchema({
    entryId: stringSchema,
    logicalId: stringSchema,
    sourceEntryId: stringSchema,
    timestamp: stringSchema,
    role: { type: 'string', enum: ['user', 'assistant'] },
    source: { type: 'string', enum: ['user', 'assistant', 'tool', 'child_task'] },
    active: booleanSchema,
    score: { type: 'number' },
    snippet: stringSchema,
    citation: stringSchema,
    entryIndex: integerSchema,
  }, [
    'entryId',
    'timestamp',
    'role',
    'source',
    'active',
    'score',
    'snippet',
    'citation',
    'entryIndex',
  ]);
  return objectSchema({
    revision: stringSchema,
    hits: arraySchema(hit),
  }, ['revision', 'hits']);
}

function createSessionParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    title: stringSchema,
    projectPath: stringSchema,
    gitRoot: stringSchema,
    surface: stringSchema,
    profileId: stringSchema,
    tag: stringSchema,
  });
}

function sessionSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    id: stringSchema,
    cursor: stringSchema,
    title: stringSchema,
    gitRoot: stringSchema,
    workspaceRoot: stringSchema,
    surface: stringSchema,
    profileId: stringSchema,
    createdAt: stringSchema,
    msgCount: integerSchema,
    tag: stringSchema,
    projectKey: stringSchema,
    archived: booleanSchema,
  }, ['id', 'title'], true);
}

function sessionFilterSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    projectRoot: stringSchema,
    scope: { enum: ['user', 'managed-task-worker', 'all'] },
    includeArchived: booleanSchema,
    limit: integerSchema,
    before: stringSchema,
    tag: stringSchema,
    surface: stringSchema,
    cursor: stringSchema,
  });
}

function learningQuerySchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    search: stringSchema,
    carrier: { enum: ['skill', 'extension', 'workflow_handoff'] },
    lifecycle: {
      enum: [
        'opportunity', 'drafting', 'ready', 'testing', 'active_learned',
        'promoted_user', 'quarantined', 'archived', 'rejected',
      ],
    },
    limit: integerSchema,
    cursor: stringSchema,
  });
}

function learnedCapabilityCommonProperties(): Record<string, RuntimeDaemonJsonSchema> {
  return {
    capabilityId: stringSchema,
    displayName: stringSchema,
    slug: stringSchema,
    lifecycle: learningLifecycleSchema(),
    revision: integerSchema,
    createdAt: stringSchema,
    updatedAt: stringSchema,
    source: objectSchema({
      kind: {
        enum: [
          'learning_controller',
          'f224_proposal',
          'skill_learning_loop',
          'legacy_manual',
        ],
      },
      proposalId: stringSchema,
    }, ['kind']),
    lastAction: {
      enum: ['review', 'trust', 'reject', 'disable', 'rollback', 'archive', 'restore', 'promote'],
    },
    artifactPath: stringSchema,
    previousGoodRevision: integerSchema,
    previousLifecycle: learningLifecycleSchema(),
    diagnostics: arraySchema(stringSchema),
  };
}

function learnedCapabilityRequired(): readonly string[] {
  return [
    'schemaVersion',
    'capabilityId',
    'displayName',
    'slug',
    'carrier',
    'lifecycle',
    'revision',
    'createdAt',
    'updatedAt',
    'source',
  ];
}

function learnedCapabilityArtifactSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    kind: { type: 'string', enum: ['skill_markdown'] },
    relativePath: stringSchema,
    fingerprint: stringSchema,
    contentRevision: integerSchema,
  }, ['kind', 'relativePath', 'fingerprint', 'contentRevision']);
}

function learnedCapabilityCanarySchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    maxInvocations: { type: 'integer', enum: [3] },
    invocationCount: integerSchema,
    verifiedSuccesses: integerSchema,
    credibleNegatives: integerSchema,
    binding: objectSchema({
      bindingId: stringSchema,
      ownerSessionRef: stringSchema,
      expiresAt: stringSchema,
    }, ['bindingId', 'ownerSessionRef', 'expiresAt']),
    invocations: arraySchema(learnedCapabilityInvocationSchema()),
  }, [
    'maxInvocations',
    'invocationCount',
    'verifiedSuccesses',
    'credibleNegatives',
    'invocations',
  ]);
}

function learnedCapabilityInvocationSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    invocationId: stringSchema,
    bindingId: stringSchema,
    usageSessionHash: stringSchema,
    artifactRevision: integerSchema,
    artifactFingerprint: stringSchema,
    status: {
      type: 'string',
      enum: ['pending', 'verified_success', 'credible_negative', 'inconclusive'],
    },
    evidenceRefs: arraySchema(stringSchema),
    invokedAt: stringSchema,
    completedAt: stringSchema,
  }, ['invocationId', 'bindingId', 'status', 'evidenceRefs', 'invokedAt']);
}

function learnedCapabilitySchema(): RuntimeDaemonJsonSchema {
  const common = learnedCapabilityCommonProperties();
  const artifact = learnedCapabilityArtifactSchema();
  const required = learnedCapabilityRequired();
  const v1 = objectSchema({
    ...common,
    schemaVersion: { type: 'integer', enum: [1] },
    carrier: { enum: ['skill', 'extension', 'workflow_handoff'] },
  }, required);
  const v2 = objectSchema({
    ...common,
    schemaVersion: { type: 'integer', enum: [2] },
    carrier: { type: 'string', enum: ['skill'] },
    scope: objectSchema({
      configHomeHash: stringSchema,
      tenantHash: stringSchema,
      projectHash: stringSchema,
    }, ['configHomeHash', 'tenantHash', 'projectHash']),
    artifact,
    previousGoodArtifact: artifact,
    provenance: objectSchema({
      jobId: stringSchema,
      inputHash: stringSchema,
      decisionId: stringSchema,
      actionId: stringSchema,
    }, ['jobId', 'inputHash', 'decisionId', 'actionId']),
    canary: learnedCapabilityCanarySchema(),
  }, [
    ...required,
    'scope',
    'artifact',
    'provenance',
    'canary',
  ]);
  return { oneOf: [v1, v2] };
}

function learningLifecycleSchema(): RuntimeDaemonJsonSchema {
  return {
    enum: [
      'opportunity', 'drafting', 'ready', 'testing', 'active_learned',
      'promoted_user', 'quarantined', 'archived', 'rejected',
    ],
  };
}

function learningEventSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    schemaVersion: { type: 'integer', enum: [1] },
    sequence: integerSchema,
    eventId: stringSchema,
    capabilityId: stringSchema,
    capabilityRevision: integerSchema,
    kind: {
      enum: ['opportunity', 'drafting', 'ready', 'testing', 'activated', 'promoted', 'attention', 'archived', 'rejected'],
    },
    lifecycle: learningLifecycleSchema(),
    displayName: stringSchema,
    slug: stringSchema,
    carrier: { enum: ['skill', 'extension', 'workflow_handoff'] },
    createdAt: stringSchema,
  }, [
    'schemaVersion', 'sequence', 'eventId', 'capabilityId', 'capabilityRevision',
    'kind', 'lifecycle', 'displayName', 'slug', 'carrier', 'createdAt',
  ]);
}

function learningSnapshotSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    ready: integerSchema,
    newlyActive: integerSchema,
    attention: integerSchema,
    active: integerSchema,
    revision: integerSchema,
  }, ['ready', 'newlyActive', 'attention', 'active', 'revision']);
}

function learningPageSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    items: arraySchema(learnedCapabilitySchema()),
    nextCursor: stringSchema,
    revision: integerSchema,
  }, ['items', 'revision']);
}

function ownerPolicySchema(mode?: 'daemon' | 'inline'): RuntimeDaemonJsonSchema {
  return objectSchema({
    mode: { type: 'string', enum: mode === undefined ? ['daemon', 'inline'] : [mode] },
    revision: integerSchema,
    updatedAt: stringSchema,
  }, ['mode', 'revision', 'updatedAt']);
}

function ownerIdentitySchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    runtimeId: stringSchema,
    pid: integerSchema,
    createdAt: stringSchema,
    kind: { type: 'string', enum: ['daemon', 'inline'] },
    processStartIdentity: stringSchema,
    processContainment: { type: 'string', enum: ['windows-job'] },
    supervisorPid: integerSchema,
    supervisorProcessStartIdentity: stringSchema,
  }, ['runtimeId', 'pid', 'createdAt']);
}

function forkSessionParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    selector: stringSchema,
    newSessionId: stringSchema,
    title: stringSchema,
    historyBoundary: conversationHistoryBoundarySchema(),
  }, ['sessionId']);
}

function conversationHistoryBoundarySchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    entryId: stringSchema,
    sourceRevision: stringSchema,
  }, ['entryId', 'sourceRevision']);
}

function activeEntryParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    entryId: stringSchema,
  }, ['sessionId', 'entryId']);
}

function compactSessionParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    provider: stringSchema,
    model: stringSchema,
    customInstructions: stringSchema,
    contextWindow: integerSchema,
    triggerPercent: { type: 'number' },
    triggerTokens: integerSchema,
    credential: credentialBindingSchema(),
  }, ['sessionId']);
}

type SchemaProperties<T> = {
  readonly [Key in keyof T]-?: RuntimeDaemonJsonSchema;
};

type RequiredKeys<T> = {
  [Key in keyof T]-?: Record<string, never> extends Pick<T, Key> ? never : Key;
}[keyof T];

function credentialBindingSchema(): RuntimeDaemonJsonSchema {
  return {
    oneOf: [
      objectSchema({
        leaseId: stringSchema,
        provider: stringSchema,
      }, ['leaseId', 'provider']),
      objectSchema({
        leaseId: stringSchema,
        mode: { type: 'string', enum: ['scoped'] },
        providers: arraySchema(stringSchema),
      }, ['leaseId', 'mode', 'providers']),
    ],
  };
}

function effectiveConfigSnapshotSchema(): RuntimeDaemonJsonSchema {
  const entry = objectSchema({
    present: booleanSchema,
    applied: booleanSchema,
    source: { enum: ['runtime_override', 'environment', 'persisted', 'unset'] },
    priority: integerSchema,
    value: anyValueSchema,
  }, ['present', 'applied', 'source', 'priority']);
  const credential = objectSchema({
    present: booleanSchema,
    source: { enum: ['environment', 'unset'] },
  }, ['present', 'source']);
  return objectSchema({
    schemaVersion: { type: 'integer', enum: [1] },
    capturedAt: stringSchema,
    persistedConfig: objectSchema({
      state: { enum: ['loaded', 'missing', 'invalid'] },
    }, ['state']),
    entries: objectSchema({}, [], entry),
    credentials: objectSchema({}, [], credential),
  }, ['schemaVersion', 'capturedAt', 'persistedConfig', 'entries', 'credentials']);
}

function startRunParamsSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    prompt: stringSchema,
    input: {
      oneOf: [objectAnySchema, arraySchema(objectAnySchema)],
    },
    mode: { enum: ['coding', 'managed_task'] },
    permissionBroker: { enum: ['runtime', 'client'] },
    options: objectAnySchema,
    agentContext: objectAnySchema,
    credential: credentialBindingSchema(),
    hostTools: objectSchema({ leaseId: stringSchema }, ['leaseId']),
  }, ['sessionId']);
}

function agentSpawnInputSchema(): RuntimeDaemonJsonSchema {
  type SpawnCapabilities = NonNullable<AgentSpawnInput['capabilities']>;
  type SpawnControl = NonNullable<SpawnCapabilities['control']>;
  const controlRequired = {
    followup: true,
    interrupt: true,
    streaming: true,
    artifacts: true,
  } satisfies Record<RequiredKeys<SpawnControl>, true>;
  const controlProperties = {
    followup: booleanSchema,
    interrupt: booleanSchema,
    streaming: booleanSchema,
    artifacts: booleanSchema,
  } satisfies SchemaProperties<SpawnControl>;
  const capabilityProperties = {
    tools: arraySchema(stringSchema),
    filesystem: { enum: ['none', 'read', 'write'] },
    network: booleanSchema,
    providers: arraySchema(stringSchema),
    canAskUser: booleanSchema,
    control: objectSchema(controlProperties, Object.keys(controlRequired)),
  } satisfies SchemaProperties<SpawnCapabilities>;
  const spawnRequired = {
    taskName: true,
    objective: true,
  } satisfies Record<RequiredKeys<AgentSpawnInput>, true>;
  const spawnProperties = {
    taskName: stringSchema,
    objective: stringSchema,
    kind: { enum: ['native', 'constructed', 'workflow', 'external'] },
    forkTurns: {
      oneOf: [
        { enum: ['all', 'none'] },
        { type: 'integer', minimum: 1 },
      ],
    },
    capabilities: objectSchema(capabilityProperties),
    metadata: objectAnySchema,
  } satisfies SchemaProperties<AgentSpawnInput>;
  return objectSchema(spawnProperties, Object.keys(spawnRequired));
}

function runFilterSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    phase: {
      oneOf: [runPhaseSchema(), arraySchema(runPhaseSchema())],
    },
  });
}

function runStatusSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    runId: stringSchema,
    sessionId: stringSchema,
    turnId: stringSchema,
    phase: runPhaseSchema(),
    stage: runStageSchema(),
    stageChangedAt: stringSchema,
    activeSubtaskCount: integerSchema,
    startedAt: stringSchema,
    endedAt: stringSchema,
    provider: stringSchema,
    model: stringSchema,
    reasoning: stringSchema,
    error: stringSchema,
    failureDetail: runtimeFailureDetailSchema(),
    lifecycleError: objectSchema({
      code: {
        enum: [
          'actor_settlement_retrying',
          'actor_settlement_not_persisted',
          'run_settlement_not_persisted',
        ],
      },
      message: stringSchema,
      retryable: booleanSchema,
    }, ['code', 'message', 'retryable']),
    terminal: runtimeTerminalFactSchema(),
    stop: runStopStatusSchema(),
  }, ['runId', 'sessionId', 'phase', 'startedAt', 'provider'], true);
}

function sessionDiagnosticsSchema(): RuntimeDaemonJsonSchema {
  const diagnosticError = objectSchema({
    code: {
      enum: [
        'run_control_unknown',
        'run_status_unknown',
        'owner_liveness_unconfirmed',
        'owner_recovery_required',
        'stop_outcome_unconfirmed',
        'actor_settlement_retrying',
        'actor_settlement_not_persisted',
        'run_settlement_not_persisted',
        'run_failed',
        'terminal_time_unknown',
      ],
    },
    message: stringSchema,
  }, ['code', 'message']);
  const diagnosticRun = objectSchema({
    controlRecord: { enum: ['present', 'unknown'] },
    runId: stringSchema,
    turnId: stringSchema,
    state: { enum: ['queued', 'active', 'terminal', 'unknown'] },
    phase: runPhaseSchema(),
    stage: runStageSchema(),
    stageChangedAt: stringSchema,
    terminalAt: stringSchema,
    terminalTimeKnown: booleanSchema,
    terminal: runtimeTerminalFactSchema(),
    failureDetail: runtimeFailureDetailSchema(),
    activeSubtaskCount: {
      oneOf: [integerSchema, { type: 'null' }],
    },
    activeSubtaskCountSource: { enum: ['run_status', 'unknown'] },
    stop: runStopStatusSchema(),
    interruptInputs: arraySchema(objectAnySchema),
    errors: arraySchema(diagnosticError),
  }, [
    'controlRecord',
    'state',
    'stage',
    'terminalTimeKnown',
    'activeSubtaskCount',
    'activeSubtaskCountSource',
    'errors',
  ]);
  return objectSchema({
    schemaVersion: { type: 'integer', enum: [1] },
    captureStartedAt: stringSchema,
    capturedAt: stringSchema,
    sdkVersion: stringSchema,
    runtimeVersion: stringSchema,
    daemonVersion: {
      oneOf: [stringSchema, { type: 'null' }],
    },
    runtimeId: stringSchema,
    runtimeMode: { enum: ['embedded', 'daemon'] },
    sessionId: stringSchema,
    observation: objectSchema({
      cursor: runtimeSessionCursorSchema(),
      transcriptRevision: stringSchema,
    }, ['cursor', 'transcriptRevision']),
    run: diagnosticRun,
  }, [
    'schemaVersion',
    'captureStartedAt',
    'capturedAt',
    'sdkVersion',
    'runtimeVersion',
    'daemonVersion',
    'runtimeId',
    'runtimeMode',
    'sessionId',
    'observation',
    'run',
  ]);
}

function runtimeTerminalFactSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    revision: integerSchema,
    kind: { enum: ['completed', 'failed', 'cancelled', 'interrupted'] },
    code: {
      enum: [
        'completed',
        'run_failed',
        'blocked',
        'cancelled',
        'interrupted',
        'runtime_restarted',
        'daemon_crashed',
        'credential_unavailable',
        'host_not_dispatched',
        'host_outcome_unknown',
        'actor_settlement_not_persisted',
        'control_history_untrusted',
      ],
    },
    effectOutcome: { enum: ['none', 'known', 'unknown'] },
    message: stringSchema,
    failureKind: runtimeFailureKindSchema(),
  }, ['revision', 'kind', 'code', 'effectOutcome']);
}

function runtimeFailureDetailSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    failureKind: runtimeFailureKindSchema(),
    stage: {
      enum: [
        'catalog',
        'credential',
        'request_build',
        'transport',
        'response_stream',
        'runtime_control',
        'runtime_settlement',
      ],
    },
    providerErrorCode: {
      enum: [
        'credential_unavailable',
        'authentication_failed',
        'rate_limited',
        'network_error',
        'tls_error',
        'request_timeout',
        'provider_not_registered',
        'catalog_error',
        'model_not_found',
        'endpoint_not_found',
        'resource_not_found',
        'request_build_failed',
        'upstream_client_error',
        'upstream_server_error',
        'protocol_mismatch',
        'response_stream_error',
        'cancelled',
        'runtime_settlement_failed',
        'context_capacity_exceeded',
        'provider_error',
      ],
    },
    safeMessage: { type: 'string', maxLength: 1_024 },
    httpStatus: { type: 'integer', minimum: 100, maximum: 599 },
    upstreamErrorCode: { type: 'string', maxLength: 200 },
    requestId: { type: 'string', maxLength: 200 },
    retryAfterMs: { type: 'integer', minimum: 0, maximum: 86_400_000 },
    contextTokens: {
      type: 'object',
      properties: {
        required: { type: 'integer', minimum: 0 },
        available: { type: 'integer', minimum: 0 },
      },
      required: ['required', 'available'],
    },
  }, ['failureKind', 'stage', 'providerErrorCode', 'safeMessage']);
}

function runtimeFailureKindSchema(): RuntimeDaemonJsonSchema {
  return {
    enum: [
      'auth',
      'rate_limit',
      'network',
      'not_found',
      'unknown_provider',
      'request',
      'upstream',
      'cancelled',
      'provider_aborted',
      'invalid_response',
      'runtime_cleanup',
      'context_capacity',
      'provider',
    ],
  };
}

function runStopStatusSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    requestedAt: stringSchema,
    state: { enum: ['unknown', 'confirmed'] },
    outcome: {
      enum: ['unknown', 'cancelled', 'interrupted', 'completed', 'failed'],
    },
    reason: stringSchema,
    resolvedAt: stringSchema,
  }, ['requestedAt', 'state', 'outcome', 'reason']);
}

function runStopReceiptSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    runId: stringSchema,
    sessionId: stringSchema,
    accepted: booleanSchema,
    state: { type: 'string', enum: ['unknown', 'confirmed'] },
    outcome: {
      type: 'string',
      enum: ['unknown', 'cancelled', 'interrupted', 'completed', 'failed'],
    },
    phase: runPhaseSchema(),
    revision: integerSchema,
  }, [
    'runId',
    'sessionId',
    'accepted',
    'state',
    'outcome',
    'phase',
    'revision',
  ]);
}

function runResultSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    runId: stringSchema,
    sessionId: stringSchema,
    phase: runPhaseSchema(),
    result: objectAnySchema,
    error: {
      oneOf: [stringSchema, objectAnySchema],
    },
    failureDetail: runtimeFailureDetailSchema(),
  }, ['runId', 'sessionId', 'phase'], true);
}

function runPhaseSchema(): RuntimeDaemonJsonSchema {
  return {
    enum: [
      'queued',
      'running',
      'waiting_agent',
      'recovering',
      'waiting_permission',
      'waiting_user_input',
      'unknown',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ],
  };
}

function runStageSchema(): RuntimeDaemonJsonSchema {
  return {
    enum: [
      'queued',
      'executing',
      'waiting_agent',
      'recovering',
      'finalizing',
      'terminal',
      'unknown',
      'starting',
      'routing',
      'preflight',
      'round',
      'worker',
      'upgrade',
      'verifying',
    ],
  };
}

function eventFilterSchema(): RuntimeDaemonJsonSchema {
  return scopedEventFilterSchema();
}

function eventReplayFilterSchema(): RuntimeDaemonJsonSchema {
  return scopedEventFilterSchema({
    after: runtimeSessionCursorSchema(),
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  });
}

function scopedEventFilterSchema(
  extra: Readonly<Record<string, RuntimeDaemonJsonSchema>> = {},
): RuntimeDaemonJsonSchema {
  const common = {
    type: { oneOf: [stringSchema, arraySchema(stringSchema)] },
    ...extra,
  };
  return {
    oneOf: [
      objectSchema({ ...common, sessionId: stringSchema }, ['sessionId']),
      objectSchema({ ...common, runId: stringSchema }, ['runId']),
      objectSchema(
        { ...common, sessionId: stringSchema, runId: stringSchema },
        ['sessionId', 'runId'],
      ),
    ],
  };
}

function runtimeEventSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    id: stringSchema,
    seq: integerSchema,
    cursor: runtimeSessionCursorSchema(),
    time: stringSchema,
    sessionId: stringSchema,
    runId: stringSchema,
    turnId: stringSchema,
    type: stringSchema,
    payload: {},
  }, ['id', 'seq', 'cursor', 'time', 'sessionId', 'runId', 'type', 'payload'], true);
}

function runtimeSessionCursorSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    journalEpoch: stringSchema,
    seq: integerSchema,
  }, ['sessionId', 'journalEpoch', 'seq']);
}

function permissionFilterSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    runId: stringSchema,
    toolName: stringSchema,
  });
}

function permissionRequestInputSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    sessionId: stringSchema,
    runId: stringSchema,
    turnId: stringSchema,
    toolCallId: stringSchema,
    toolName: stringSchema,
    reason: stringSchema,
    risk: { enum: ['low', 'medium', 'high'] },
    // The Runtime replaces caller input with its own bounded/redacted JSON
    // summary before the request becomes observable or is returned.
    inputPreview: stringSchema,
    // Public concrete-call input. The Runtime canonicalizes this value and
    // issues opaque grant candidates; raw input is never copied to events or
    // persisted grants.
    toolInput: objectAnySchema,
    executionCwd: { type: 'string', maxLength: 4_096 },
    autoModeDiagnostics: objectAnySchema,
    expiresAt: stringSchema,
    timeoutMs: integerSchema,
  }, ['sessionId', 'runId', 'toolName']);
}

function permissionRequestSchema(): RuntimeDaemonJsonSchema {
  const {
    toolInput: _toolInput,
    ...observableRequestProperties
  } = permissionRequestInputSchema().properties ?? {};
  return objectSchema({
    ...observableRequestProperties,
    inputPreview: { type: 'string', maxLength: 8_192 },
    grantSuggestions: arraySchema(objectSchema({
      id: stringSchema,
      kind: { enum: ['session', 'persistent'] },
      label: { type: 'string', maxLength: 512 },
    }, ['id', 'kind', 'label'])),
    id: stringSchema,
    createdAt: stringSchema,
  }, ['id', 'sessionId', 'runId', 'toolName', 'createdAt'], true);
}

function permissionDecisionSchema(): RuntimeDaemonJsonSchema {
  return {
    oneOf: [
      objectSchema({ type: { enum: ['allow_once'] } }, ['type']),
      objectSchema({
        type: { enum: ['allow_session'] },
        suggestionId: stringSchema,
      }, ['type', 'suggestionId']),
      objectSchema({
        type: { enum: ['allow_always'] },
        suggestionId: stringSchema,
      }, ['type', 'suggestionId']),
      objectSchema({
        type: { enum: ['allow_always'] },
        scope: objectSchema({
          toolName: stringSchema,
          sessionId: stringSchema,
          matcher: runtimePermissionMatcherSchema(),
        }),
      }, ['type', 'scope']),
      objectSchema({
        type: { enum: ['reject'] },
        reason: stringSchema,
        cause: { enum: ['approval_timeout'] },
      }, ['type']),
    ],
  };
}

function runtimePermissionMatcherSchema(): RuntimeDaemonJsonSchema {
  const base = {
    version: { type: 'integer' as const, enum: [1] },
    toolName: stringSchema,
    fingerprint: stringSchema,
  };
  return {
    oneOf: [
      objectSchema({
        ...base,
        kind: { enum: ['exact-command'] },
        shell: { enum: ['cmd', 'posix', 'powershell'] },
        shellContractFingerprint: stringSchema,
        commandFingerprint: stringSchema,
        cwd: stringSchema,
        executable: stringSchema,
        argvFingerprint: stringSchema,
        background: booleanSchema,
      }, [
        'version', 'kind', 'toolName', 'fingerprint', 'shell',
        'commandFingerprint', 'cwd', 'background',
      ]),
      objectSchema({
        ...base,
        kind: { enum: ['exact-path'] },
        path: stringSchema,
      }, ['version', 'kind', 'toolName', 'fingerprint', 'path']),
      objectSchema({
        ...base,
        kind: { enum: ['exact-call'] },
        cwd: stringSchema,
        inputFingerprint: stringSchema,
      }, [
        'version', 'kind', 'toolName', 'fingerprint', 'cwd', 'inputFingerprint',
      ]),
    ],
  };
}

function workflowFilterSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    runId: stringSchema,
    activeOnly: booleanSchema,
    limit: integerSchema,
  });
}

function artifactSchema(): RuntimeDaemonJsonSchema {
  return objectSchema({
    id: stringSchema,
    kind: { enum: ['image', 'file', 'video'] },
    path: stringSchema,
    sizeBytes: integerSchema,
    mediaType: stringSchema,
    mimeType: stringSchema,
    name: stringSchema,
    source: { enum: ['user-inline', 'clipboard', 'drag-drop', 'file-picker'] },
    description: stringSchema,
    createdAt: stringSchema,
  }, ['id', 'kind', 'path', 'sizeBytes', 'createdAt'], true);
}
