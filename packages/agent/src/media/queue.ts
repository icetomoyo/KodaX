import {
  actorQueueId,
  getMessageQueue,
  resolveActiveRootQueueRoute,
  type MessagePriority,
} from '../messaging/index.js';
import type { KodaXInputArtifact } from './types.js';
import {
  validateInputArtifactsForModel,
  type ValidateInputArtifactsOptions,
} from './validation.js';

export interface EnqueueWithArtifactsInput extends ValidateInputArtifactsOptions {
  readonly content: string;
  /** Accepted client input identity stamped onto the drained user message. */
  readonly inputId?: string;
  readonly inputArtifacts?: readonly KodaXInputArtifact[];
  readonly priority?: MessagePriority;
  /** Explicit low-level queue route. Mutually exclusive with sessionId. */
  readonly agentId?: string;
  /** Route to this Actor session's root queue. */
  readonly sessionId?: string;
}

export function enqueueWithArtifacts(input: EnqueueWithArtifactsInput): string {
  validateInputArtifactsForModel(input.inputArtifacts ?? [], input);
  if (input.agentId !== undefined && input.sessionId !== undefined) {
    throw new Error('enqueueWithArtifacts accepts either agentId or sessionId, not both.');
  }
  if (input.sessionId !== undefined && input.sessionId.trim().length === 0) {
    throw new Error('enqueueWithArtifacts sessionId must not be empty.');
  }
  const agentId = input.agentId
    ?? (input.sessionId !== undefined
      ? actorQueueId(input.sessionId, '/root')
      : resolveActiveRootQueueRoute());
  return getMessageQueue().enqueue({
    priority: input.priority ?? 'user',
    mode: 'prompt',
    content: input.content,
    ...(input.inputId !== undefined ? { inputId: input.inputId } : {}),
    agentId,
    inputArtifacts: input.inputArtifacts,
  });
}
