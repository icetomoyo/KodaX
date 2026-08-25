import type {
  RuntimeEventEnvelope,
  RuntimeEventParseResult,
  RuntimeSessionCursor,
  RuntimeEventType,
  RuntimeTypedEvent,
} from './sdk-runtime.js';

const RUNTIME_EVENT_TYPES: ReadonlySet<string> = new Set<RuntimeEventType>([
  'session.created', 'session.loaded', 'session.settings.updated', 'session.notice.appended',
  'session.rewound', 'session.active_entry.updated', 'session.compacted', 'run.queued',
  'run.started', 'run.updated', 'run.progress', 'run.input.queued', 'run.input.delivered',
  'turn.started', 'turn.completed', 'turn.failed', 'output.segment.started',
  'assistant.delta', 'thinking.delta', 'thinking.finished', 'tool.started', 'tool.progress',
  'tool.sandbox', 'tool.finished', 'user_input.requested', 'user_input.resolved', 'permission.requested',
  'permission.resolved', 'permission.grant.changed', 'workflow.started', 'workflow.updated',
  'workflow.finished',
  'context.compaction.started', 'context.compaction.stats', 'context.compaction.finished',
  'context.compaction.messages', 'context.compaction.ended', 'context.compaction.skipped',
  'context.budget.snapshot', 'tool.exposure.planned', 'child_activity.finished', 'provider.retry',
  'provider.recovery', 'provider.cache.diagnostics', 'repo_intelligence.trace', 'todo.updated',
  'todo.warning', 'sidecar.message',
  'run.completed', 'run.failed', 'run.cancelled', 'run.interrupted', 'artifact.created',
  'config.effective', 'runtime.warning',
]);

const RUN_STATUS_EVENT_TYPES: ReadonlySet<string> = new Set<RuntimeEventType>([
  'run.queued',
  'run.started',
  'run.updated',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
]);

export function parseRuntimeEvent(value: unknown): RuntimeEventParseResult {
  if (!isRecord(value)) return invalid('Runtime event must be an object.');
  if (
    typeof value.id !== 'string'
    || !Number.isSafeInteger(value.seq)
    || typeof value.seq !== 'number'
    || typeof value.time !== 'string'
    || typeof value.sessionId !== 'string'
    || typeof value.runId !== 'string'
    || (value.turnId !== undefined && typeof value.turnId !== 'string')
    || typeof value.type !== 'string'
    || !RUNTIME_EVENT_TYPES.has(value.type)
  ) return invalid('Runtime event envelope is malformed or has an unknown type.');

  if (
    (value.type === 'assistant.delta' || value.type === 'thinking.delta')
    && (!isRecord(value.payload) || typeof value.payload.text !== 'string')
  ) return invalid(`${value.type} requires a string text payload.`);
  if (RUN_STATUS_EVENT_TYPES.has(value.type) && !isRuntimeRunStatusPayload(value.payload)) {
    return invalid(`${value.type} requires a RuntimeRunStatus payload.`);
  }
  const payloadError = validateKnownRuntimeEventPayload(value.type as RuntimeEventType, value.payload);
  if (payloadError !== undefined) return invalid(`${value.type} ${payloadError}`);
  const parsedCursor = parseRuntimeSessionCursor(value.cursor);
  if (
    parsedCursor === undefined
    || parsedCursor.sessionId !== value.sessionId
    || parsedCursor.seq !== value.seq
  ) return invalid('Runtime event cursor does not match its Session envelope.');

  const envelope: RuntimeEventEnvelope = {
    id: value.id,
    seq: value.seq,
    cursor: parsedCursor,
    time: value.time,
    sessionId: value.sessionId,
    runId: value.runId,
    ...(typeof value.turnId === 'string' ? { turnId: value.turnId } : {}),
    type: value.type as RuntimeEventType,
    payload: value.payload,
  };
  return { ok: true, event: envelope as RuntimeTypedEvent };
}

function parseRuntimeSessionCursor(value: unknown): RuntimeSessionCursor | undefined {
  if (
    !isRecord(value)
    || typeof value.sessionId !== 'string'
    || value.sessionId.length === 0
    || typeof value.journalEpoch !== 'string'
    || value.journalEpoch.length === 0
    || !Number.isSafeInteger(value.seq)
    || typeof value.seq !== 'number'
    || value.seq < 0
  ) return undefined;
  return {
    sessionId: value.sessionId,
    journalEpoch: value.journalEpoch,
    seq: value.seq,
  };
}

function validateKnownRuntimeEventPayload(
  type: RuntimeEventType,
  payload: unknown,
): string | undefined {
  if (type === 'session.created') {
    return hasStrings(payload, ['id', 'title']) ? undefined : 'requires a RuntimeSession payload.';
  }
  if (type === 'session.loaded') {
    return hasStrings(payload, ['id', 'title']) || hasStrings(payload, ['provider', 'sessionId'])
      ? undefined
      : 'requires a RuntimeSession or provider session payload.';
  }
  if (type === 'session.settings.updated') {
    return isRecord(payload)
      && typeof payload.sessionId === 'string'
      && Number.isSafeInteger(payload.revision)
      && isRecord(payload.settings)
      && isRecord(payload.patch)
      ? undefined
      : 'requires a session settings update payload.';
  }
  if (type === 'thinking.finished') {
    return isRecord(payload) && typeof payload.thinking === 'string'
      ? undefined
      : 'requires a string thinking payload.';
  }
  if (type === 'output.segment.started') {
    return isRecord(payload)
      && typeof payload.responseId === 'string'
      && payload.responseId.length > 0
      && typeof payload.providerRequestId === 'string'
      && payload.providerRequestId.length > 0
      && (payload.mode === 'append' || payload.mode === 'replace')
      ? undefined
      : 'requires responseId, providerRequestId, and append/replace mode.';
  }
  if (type === 'tool.started') {
    return isRecord(payload)
      && hasStrings(payload.tool, ['id', 'name'])
      ? undefined
      : 'requires a tool descriptor payload.';
  }
  if (type === 'tool.progress') {
    const valid = isRecord(payload) && (
      (hasStrings(payload.update, ['id', 'message']))
      || (typeof payload.toolName === 'string' && typeof payload.partialJson === 'string')
    );
    return valid ? undefined : 'requires a tool progress payload.';
  }
  if (type === 'tool.sandbox') {
    const update = isRecord(payload) && isRecord(payload.update)
      ? payload.update
      : undefined;
    const observation = update && isRecord(update.observation)
      ? update.observation
      : undefined;
    const valid = typeof update?.id === 'string'
      && observation?.version === 1
      && (
        observation.state === 'not_selected'
        || (
          observation.state === 'fallback'
          && (
            observation.reason === 'not_ready'
            || observation.reason === 'prepare_failed'
            || observation.reason === 'backend_failed'
            || observation.reason === 'session_reset_pending'
            || observation.reason === 'acl_transition_pending'
          )
          && observation.execution === 'normal_permission_policy'
        )
        || (
          observation.state === 'applied'
          && (
            observation.backend === 'windows-restricted-user'
            || observation.backend === 'macos-seatbelt'
            || observation.backend === 'linux-bubblewrap'
            || observation.backend === 'unsupported'
          )
          && observation.policyId === 'kodax-workspace-shell-v1'
        )
      );
    return valid ? undefined : 'requires a sandbox observation payload.';
  }
  if (type === 'tool.finished') {
    return isRecord(payload) && hasStrings(payload.result, ['id', 'name', 'content'])
      ? undefined
      : 'requires a tool result payload.';
  }
  if (type === 'run.progress') return validateRunProgressPayload(payload);
  if (type === 'run.input.queued') {
    return isRecord(payload) && isRuntimeInterruptInputStatus(payload.input, 'queued')
      ? undefined
      : 'requires a queued interrupt input payload.';
  }
  if (type === 'run.input.delivered') {
    return isRecord(payload)
      && Array.isArray(payload.inputs)
      && payload.inputs.length > 0
      && payload.inputs.every(isDeliveredInterruptInput)
      ? undefined
      : 'requires an ordered interrupt input batch.';
  }
  if (type === 'context.compaction.finished') {
    const valid = isRecord(payload)
      && typeof payload.contextId === 'string'
      && (payload.contextKind === 'root' || payload.contextKind === 'child')
      && Number.isSafeInteger(payload.contextRevision)
      && Number.isSafeInteger(payload.beforeRevision)
      && Number.isSafeInteger(payload.afterRevision)
      && (
        payload.source === 'manual'
        || payload.source === 'automatic_threshold'
        || payload.source === 'physical_capacity'
      )
      && typeof payload.tokensBefore === 'number'
      && typeof payload.tokensAfter === 'number'
      && typeof payload.committed === 'boolean'
      && typeof payload.elapsedMs === 'number';
    return valid
      ? undefined
      : 'requires a canonical compaction payload.';
  }
  if (type === 'context.compaction.started') {
    return isRecord(payload)
      && (payload.meta === undefined || isRecord(payload.meta))
      ? undefined
      : 'requires an optional activity meta payload.';
  }
  if (type === 'context.compaction.stats') {
    return isRecord(payload)
      && typeof payload.tokensBefore === 'number'
      && typeof payload.tokensAfter === 'number'
      ? undefined
      : 'requires numeric token statistics.';
  }
  if (type === 'context.compaction.skipped') {
    const valid = isRecord(payload)
      && isCompactionSkipReason(payload.reason)
      && typeof payload.currentTokens === 'number'
      && typeof payload.contextWindow === 'number'
      && typeof payload.triggerPercent === 'number'
      && typeof payload.cooldownTurnsRemaining === 'number'
      && typeof payload.lowSavingsStreak === 'number'
      && isOptionalNumber(payload.compactableTokens)
      && isOptionalNumber(payload.effectiveTriggerTokens)
      && isOptionalNumber(payload.consecutiveFailures)
      && isOptionalNumber(payload.circuitBreakerLimit)
      && isOptionalNumber(payload.rearmAtTokens)
      && isOptionalCircuitBreakerState(payload.circuitBreakerState);
    return valid ? undefined : 'requires a structured skip reason.';
  }
  if (type === 'context.compaction.ended') {
    if (!isRecord(payload) || (payload.meta !== undefined && !isRecord(payload.meta))) {
      return 'requires a compaction lifecycle payload.';
    }
    if (payload.outcome === undefined) {
      const legacy = payload.reason === undefined
        && payload.failurePhase === undefined
        && payload.currentTokens === undefined
        && payload.compactableTokens === undefined
        && payload.consecutiveFailures === undefined
        && payload.circuitBreakerLimit === undefined
        && payload.circuitBreakerState === undefined
        && payload.cooldownTurnsRemaining === undefined;
      return legacy ? undefined : 'requires a structured compaction outcome.';
    }
    const valid = typeof payload.currentTokens === 'number'
      && typeof payload.compactableTokens === 'number'
      && typeof payload.consecutiveFailures === 'number'
      && typeof payload.circuitBreakerLimit === 'number'
      && isOptionalCircuitBreakerState(payload.circuitBreakerState)
      && payload.circuitBreakerState !== undefined
      && typeof payload.cooldownTurnsRemaining === 'number'
      && isCompactionEndOutcome(payload);
    return valid ? undefined : 'requires a structured compaction outcome.';
  }
  if (type === 'todo.updated') {
    return isRecord(payload) && Array.isArray(payload.items)
      ? undefined
      : 'requires an items array payload.';
  }
  if (type === 'user_input.requested') {
    const sharedRequest = isRecord(payload)
      && hasStrings(payload, ['id', 'sessionId', 'runId', 'kind', 'createdAt', 'expiresAt'])
      && Number.isSafeInteger(payload.revision);
    const embeddedRequest = isRecord(payload)
      && hasStrings(payload, ['requestId', 'kind'])
      && Object.hasOwn(payload, 'options');
    return sharedRequest || embeddedRequest
      ? undefined
      : 'requires a user input request payload.';
  }
  if (type === 'user_input.resolved' || type === 'permission.resolved') {
    return isRecord(payload) && typeof payload.requestId === 'string'
      ? undefined
      : 'requires a requestId payload.';
  }
  if (type === 'permission.requested') {
    return hasStrings(payload, ['id', 'sessionId', 'runId', 'toolName', 'createdAt'])
      ? undefined
      : 'requires a RuntimePermissionRequest payload.';
  }
  if (type === 'permission.grant.changed') {
    return isRecord(payload)
      && (payload.action === 'created' || payload.action === 'revoked' || payload.action === 'expired')
      && isRecord(payload.grant)
      && typeof payload.grant.id === 'string'
      && Number.isSafeInteger(payload.revision)
      ? undefined
      : 'requires a permission grant audit payload.';
  }
  if (type === 'turn.started' || type === 'turn.completed' || type === 'turn.failed') {
    return hasStrings(payload, ['sessionId', 'turnId'])
      ? undefined
      : 'requires a turn payload.';
  }
  if (type === 'workflow.started' || type === 'workflow.updated' || type === 'workflow.finished') {
    return isRecord(payload) ? undefined : 'requires a workflow event payload.';
  }
  if (
    type === 'context.budget.snapshot'
    || type === 'tool.exposure.planned'
    || type === 'provider.cache.diagnostics'
  ) {
    return isRecord(payload) ? undefined : 'requires an object payload.';
  }
  if (type === 'runtime.warning') {
    return isRecord(payload) && typeof payload.message === 'string'
      ? undefined
      : 'requires a warning message payload.';
  }
  return undefined;
}

function isCompactionSkipReason(value: unknown): boolean {
  return value === 'low_savings_cooldown'
    || value === 'covered_context_unchanged'
    || value === 'compactable_below_threshold'
    || value === 'no_compactable_prefix'
    || value === 'circuit_breaker_cooldown';
}

function isCompactionFailureReason(value: unknown): boolean {
  return value === 'summary_generation_failed'
    || value === 'persistence_failed'
    || value === 'context_capacity_exceeded'
    || value === 'post_processing_failed';
}

function isCompactionEndOutcome(payload: Record<string, unknown>): boolean {
  if (payload.outcome === 'compacted') {
    return payload.reason === undefined && payload.failurePhase === undefined;
  }
  if (payload.outcome === 'skipped') {
    return isCompactionSkipReason(payload.reason) && payload.failurePhase === undefined;
  }
  if (payload.outcome !== 'failed' || !isCompactionFailureReason(payload.reason)) {
    return false;
  }
  if (payload.reason === 'summary_generation_failed') {
    return payload.failurePhase === 'summary_generation';
  }
  if (payload.reason === 'persistence_failed') {
    return payload.failurePhase === 'persistence';
  }
  if (payload.reason === 'post_processing_failed') {
    return payload.failurePhase === 'post_processing';
  }
  return payload.failurePhase === undefined;
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}

function isOptionalCircuitBreakerState(value: unknown): boolean {
  return value === undefined
    || value === 'closed'
    || value === 'open'
    || value === 'half_open';
}

function validateRunProgressPayload(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.kind !== 'string') {
    return 'requires a discriminated progress payload.';
  }
  if (payload.kind === 'managed_task_status') {
    return isRecord(payload.status)
      ? undefined
      : 'requires managed task status.';
  }
  if (payload.kind === 'iteration_start') {
    return typeof payload.iter === 'number' && typeof payload.maxIter === 'number'
      ? undefined
      : 'requires iteration counters.';
  }
  if (payload.kind === 'iteration_end') {
    return isRecord(payload.info) ? undefined : 'requires iteration info.';
  }
  if (payload.kind === 'mid_turn_user_messages') {
    return Array.isArray(payload.contents) && payload.contents.every((item) => typeof item === 'string')
      ? undefined
      : 'requires string contents.';
  }
  return payload.kind === 'stream_end' || payload.kind === 'complete'
    ? undefined
    : 'has an unknown progress kind.';
}

function isRuntimeRunStatusPayload(value: unknown): boolean {
  return isRecord(value)
    && typeof value.runId === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.startedAt === 'string'
    && typeof value.provider === 'string'
    && typeof value.phase === 'string';
}

function isRuntimeInterruptInputStatus(
  value: unknown,
  expectedState?: 'queued' | 'delivered' | 'terminal',
): boolean {
  return isRecord(value)
    && typeof value.inputId === 'string'
    && typeof value.afterRunId === 'string'
    && value.delivery === 'interrupt'
    && (value.state === 'queued' || value.state === 'delivered' || value.state === 'terminal')
    && (expectedState === undefined || value.state === expectedState)
    && typeof value.contentPreview === 'string'
    && typeof value.queuedAt === 'string'
    && (value.deliveredAt === undefined || typeof value.deliveredAt === 'string');
}

function isDeliveredInterruptInput(value: unknown): boolean {
  return isRecord(value)
    && typeof value.inputId === 'string'
    && typeof value.afterRunId === 'string'
    && typeof value.queuedAt === 'string'
    && typeof value.deliveredAt === 'string'
    && (value.entryId === undefined
      || (typeof value.entryId === 'string' && value.entryId.length > 0))
    && isRuntimeInput(value.input);
}

function isRuntimeInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(isRuntimeInput);
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'text') return typeof value.text === 'string';
  if (value.type === 'artifact_ref') return typeof value.artifactId === 'string';
  if (value.type === 'image' || value.type === 'file') return typeof value.path === 'string';
  return value.type === 'video'
    && typeof value.path === 'string'
    && typeof value.mediaType === 'string';
}

function hasStrings(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => typeof value[key] === 'string');
}

function invalid(error: string): RuntimeEventParseResult {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
