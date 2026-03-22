import type {
  KodaXContentBlock,
  KodaXMessage,
  SessionErrorMetadata,
} from '@kodax/coding';
import type { BrainstormSession } from './project-brainstorm.js';
import type { FeatureList, ProjectFeature, ProjectWorkflowState } from './project-state.js';

const MESSAGE_ROLES = new Set<KodaXMessage['role']>(['user', 'assistant', 'system']);
const WORKFLOW_STAGES = new Set<ProjectWorkflowState['stage']>([
  'bootstrap',
  'discovering',
  'aligned',
  'planned',
  'executing',
  'blocked',
  'completed',
]);
const WORKFLOW_SCOPES = new Set<ProjectWorkflowState['scope']>(['project', 'change_request']);
const BRAINSTORM_STATUSES = new Set<BrainstormSession['status']>(['active', 'completed']);
const BRAINSTORM_ROLES = new Set<BrainstormSession['turns'][number]['role']>(['user', 'assistant']);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
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

function isProjectFeature(value: unknown): value is ProjectFeature {
  if (!isRecord(value)) {
    return false;
  }

  return (value.name === undefined || typeof value.name === 'string')
    && (value.description === undefined || typeof value.description === 'string')
    && (value.steps === undefined || isStringArray(value.steps))
    && (value.passes === undefined || typeof value.passes === 'boolean')
    && (value.skipped === undefined || typeof value.skipped === 'boolean')
    && (value.startedAt === undefined || typeof value.startedAt === 'string')
    && (value.completedAt === undefined || typeof value.completedAt === 'string')
    && (value.notes === undefined || typeof value.notes === 'string');
}

export function isFeatureList(value: unknown): value is FeatureList {
  return isRecord(value) && Array.isArray(value.features) && value.features.every(isProjectFeature);
}

export function isProjectWorkflowState(value: unknown): value is ProjectWorkflowState {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.stage === 'string'
    && WORKFLOW_STAGES.has(value.stage as ProjectWorkflowState['stage'])
    && typeof value.scope === 'string'
    && WORKFLOW_SCOPES.has(value.scope as ProjectWorkflowState['scope'])
    && typeof value.unresolvedQuestionCount === 'number'
    && typeof value.lastUpdated === 'string'
    && typeof value.discoveryStepIndex === 'number'
    && (value.activeRequestId === undefined || typeof value.activeRequestId === 'string')
    && (value.currentFeatureIndex === undefined || typeof value.currentFeatureIndex === 'number')
    && (value.lastPlannedAt === undefined || typeof value.lastPlannedAt === 'string')
    && (value.latestExecutionSummary === undefined || typeof value.latestExecutionSummary === 'string');
}

export function isBrainstormSession(value: unknown): value is BrainstormSession {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.id === 'string'
    && typeof value.topic === 'string'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && typeof value.status === 'string'
    && BRAINSTORM_STATUSES.has(value.status as BrainstormSession['status'])
    && Array.isArray(value.turns)
    && value.turns.every(turn =>
      isRecord(turn)
      && typeof turn.role === 'string'
      && BRAINSTORM_ROLES.has(turn.role as BrainstormSession['turns'][number]['role'])
      && typeof turn.text === 'string'
      && typeof turn.createdAt === 'string'
    );
}
