import type {
  KodaXContentBlock,
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXJsonValue,
  KodaXManagedTask,
  KodaXMessage,
  KodaXSessionUiHistoryItem,
  SessionErrorMetadata,
} from '@kodax/coding';

const MESSAGE_ROLES = new Set<KodaXMessage['role']>(['user', 'assistant', 'system']);
const TASK_SURFACES = new Set<NonNullable<KodaXManagedTask['contract']['surface']>>(['cli', 'repl', 'plan']);
const TASK_STATUSES = new Set<NonNullable<KodaXManagedTask['contract']['status']>>([
  'planned',
  'running',
  'blocked',
  'failed',
  'completed',
]);
const TASK_ROLES = new Set<NonNullable<KodaXManagedTask['roleAssignments'][number]['role']>>([
  'direct',
  'scout',
  'planner',
  'generator',
  'evaluator',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function isKodaXJsonValue(value: unknown): value is KodaXJsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isKodaXJsonValue);
  }

  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  return Object.values(value).every(isKodaXJsonValue);
}

export function isKodaXExtensionSessionRecord(
  value: unknown,
): value is KodaXExtensionSessionRecord {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.extensionId === 'string'
    && typeof value.type === 'string'
    && typeof value.ts === 'number'
    && (value.data === undefined || isKodaXJsonValue(value.data))
    && (value.dedupeKey === undefined || typeof value.dedupeKey === 'string');
}

export function isKodaXExtensionSessionState(
  value: unknown,
): value is KodaXExtensionSessionState {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry) => {
    if (!isRecord(entry)) {
      return false;
    }

    return Object.values(entry).every(isKodaXJsonValue);
  });
}

function isKodaXContentBlock(value: unknown): value is KodaXContentBlock {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'text':
      return typeof value.text === 'string';
    case 'tool_use':
      return typeof value.id === 'string'
        && typeof value.name === 'string'
        && isRecord(value.input);
    case 'tool_result':
      return typeof value.tool_use_id === 'string'
        && typeof value.content === 'string'
        && (value.is_error === undefined || typeof value.is_error === 'boolean');
    case 'image':
      return typeof value.path === 'string'
        && (value.mediaType === undefined || typeof value.mediaType === 'string');
    case 'thinking':
      return typeof value.thinking === 'string'
        && (value.signature === undefined || typeof value.signature === 'string');
    case 'redacted_thinking':
      return typeof value.data === 'string';
    default:
      return false;
  }
}

export function isKodaXMessage(value: unknown): value is KodaXMessage {
  if (!isRecord(value) || typeof value.role !== 'string' || !MESSAGE_ROLES.has(value.role as KodaXMessage['role'])) {
    return false;
  }

  return typeof value.content === 'string'
    || (Array.isArray(value.content) && value.content.every(isKodaXContentBlock));
}

export function isSessionErrorMetadata(value: unknown): value is SessionErrorMetadata {
  if (!isRecord(value)) {
    return false;
  }

  return (value.lastError === undefined || typeof value.lastError === 'string')
    && (value.lastErrorTime === undefined || typeof value.lastErrorTime === 'number')
    && (value.consecutiveErrors === undefined || typeof value.consecutiveErrors === 'number');
}

export function isKodaXSessionUiHistoryItem(value: unknown): value is KodaXSessionUiHistoryItem {
  return isRecord(value)
    && typeof value.type === 'string'
    && (
      value.type === 'user'
      || value.type === 'assistant'
      || value.type === 'system'
      || value.type === 'thinking'
      || value.type === 'error'
      || value.type === 'info'
      || value.type === 'hint'
    )
    && typeof value.text === 'string';
}

export function isKodaXSessionUiHistory(value: unknown): value is KodaXSessionUiHistoryItem[] {
  return Array.isArray(value) && value.every(isKodaXSessionUiHistoryItem);
}

function isKodaXTaskCapabilityHint(value: unknown): boolean {
  return isRecord(value)
    && typeof value.kind === 'string'
    && (value.kind === 'skill' || value.kind === 'tool' || value.kind === 'command' || value.kind === 'workflow')
    && typeof value.name === 'string'
    && (value.details === undefined || typeof value.details === 'string');
}

function isKodaXTaskVerificationContract(value: unknown): boolean {
  return isRecord(value)
    && (value.summary === undefined || typeof value.summary === 'string')
    && (value.instructions === undefined || isStringArray(value.instructions))
    && (value.requiredEvidence === undefined || isStringArray(value.requiredEvidence))
    && (value.requiredChecks === undefined || isStringArray(value.requiredChecks))
    && (value.capabilityHints === undefined
      || (Array.isArray(value.capabilityHints) && value.capabilityHints.every(isKodaXTaskCapabilityHint)));
}

function isKodaXTaskToolPolicy(value: unknown): boolean {
  return isRecord(value)
    && typeof value.summary === 'string'
    && (value.allowedTools === undefined || isStringArray(value.allowedTools))
    && (value.blockedTools === undefined || isStringArray(value.blockedTools))
    && (value.allowedShellPatterns === undefined || isStringArray(value.allowedShellPatterns));
}

export function isKodaXManagedTask(value: unknown): value is KodaXManagedTask {
  if (!isRecord(value) || !isRecord(value.contract) || !isRecord(value.evidence) || !isRecord(value.verdict)) {
    return false;
  }

  const contract = value.contract;
  const evidence = value.evidence;
  const verdict = value.verdict;

  return typeof contract.taskId === 'string'
    && typeof contract.objective === 'string'
    && typeof contract.createdAt === 'string'
    && typeof contract.updatedAt === 'string'
    && typeof contract.surface === 'string'
    && TASK_SURFACES.has(contract.surface as KodaXManagedTask['contract']['surface'])
    && typeof contract.status === 'string'
    && TASK_STATUSES.has(contract.status as KodaXManagedTask['contract']['status'])
    && typeof contract.primaryTask === 'string'
    && typeof contract.workIntent === 'string'
    && typeof contract.complexity === 'string'
    && typeof contract.riskLevel === 'string'
    && typeof contract.harnessProfile === 'string'
    && typeof contract.recommendedMode === 'string'
    && typeof contract.requiresBrainstorm === 'boolean'
    && typeof contract.reason === 'string'
    && (contract.contractSummary === undefined || typeof contract.contractSummary === 'string')
    && Array.isArray(contract.successCriteria)
    && contract.successCriteria.every((item) => typeof item === 'string')
    && Array.isArray(contract.requiredEvidence)
    && contract.requiredEvidence.every((item) => typeof item === 'string')
    && Array.isArray(contract.constraints)
    && contract.constraints.every((item) => typeof item === 'string')
    && (contract.contractCreatedByAssignmentId === undefined || typeof contract.contractCreatedByAssignmentId === 'string')
    && (contract.contractUpdatedAt === undefined || typeof contract.contractUpdatedAt === 'string')
    && (contract.metadata === undefined || (
      isRecord(contract.metadata)
      && Object.values(contract.metadata).every(isKodaXJsonValue)
    ))
    && (contract.verification === undefined || isKodaXTaskVerificationContract(contract.verification))
    && Array.isArray(value.roleAssignments)
    && value.roleAssignments.every((assignment) =>
      isRecord(assignment)
      && typeof assignment.id === 'string'
      && typeof assignment.role === 'string'
      && TASK_ROLES.has(assignment.role as KodaXManagedTask['roleAssignments'][number]['role'])
      && typeof assignment.title === 'string'
      && Array.isArray(assignment.dependsOn)
      && assignment.dependsOn.every((dependency) => typeof dependency === 'string')
      && typeof assignment.status === 'string'
      && TASK_STATUSES.has(assignment.status as KodaXManagedTask['roleAssignments'][number]['status'])
      && (assignment.agent === undefined || typeof assignment.agent === 'string')
      && (assignment.toolPolicy === undefined || isKodaXTaskToolPolicy(assignment.toolPolicy))
      && (assignment.summary === undefined || typeof assignment.summary === 'string')
      && (assignment.sessionId === undefined || typeof assignment.sessionId === 'string')
    )
    && Array.isArray(value.workItems)
    && value.workItems.every((item) =>
      isRecord(item)
      && typeof item.id === 'string'
      && typeof item.assignmentId === 'string'
      && typeof item.description === 'string'
      && (item.execution === 'serial' || item.execution === 'parallel')
    )
    && typeof evidence.workspaceDir === 'string'
    && (evidence.runId === undefined || typeof evidence.runId === 'string')
    && Array.isArray(evidence.artifacts)
    && evidence.artifacts.every((artifact) =>
      isRecord(artifact)
      && (
        artifact.kind === 'json'
        || artifact.kind === 'text'
        || artifact.kind === 'markdown'
        || artifact.kind === 'image'
      )
      && typeof artifact.path === 'string'
      && (artifact.description === undefined || typeof artifact.description === 'string')
    )
    && Array.isArray(evidence.entries)
    && evidence.entries.every((entry) =>
      isRecord(entry)
      && typeof entry.assignmentId === 'string'
      && typeof entry.role === 'string'
      && TASK_ROLES.has(entry.role as KodaXManagedTask['evidence']['entries'][number]['role'])
      && typeof entry.status === 'string'
      && TASK_STATUSES.has(entry.status as KodaXManagedTask['evidence']['entries'][number]['status'])
      && (entry.summary === undefined || typeof entry.summary === 'string')
      && (entry.sessionId === undefined || typeof entry.sessionId === 'string')
      && (entry.signal === undefined || entry.signal === 'COMPLETE' || entry.signal === 'BLOCKED' || entry.signal === 'DECIDE')
      && (entry.signalReason === undefined || typeof entry.signalReason === 'string')
    )
    && Array.isArray(evidence.routingNotes)
    && evidence.routingNotes.every((note) => typeof note === 'string')
    && typeof verdict.status === 'string'
    && TASK_STATUSES.has(verdict.status as KodaXManagedTask['verdict']['status'])
    && typeof verdict.decidedByAssignmentId === 'string'
    && typeof verdict.summary === 'string'
    && (verdict.signal === undefined || verdict.signal === 'COMPLETE' || verdict.signal === 'BLOCKED' || verdict.signal === 'DECIDE')
    && (verdict.signalReason === undefined || typeof verdict.signalReason === 'string');
}
