/**
 * Typed Interaction mapping over the Host's user-input and permission
 * registries (FEATURE_298 T05). One surface, precise request ids, first valid
 * answer wins — the client path never carries revision or lease requirements.
 */
import type {
  AskUserMultiOptions,
  AskUserQuestionOptions,
} from '@kodax-ai/agent';
import type {
  ClientInteraction,
  ClientInteractionResponse,
  ClientInteractionResult,
  ClientPermissionDecision,
} from '@kodax-ai/coding/client-contract';
import type {
  RuntimePermissionDecision,
  RuntimePermissionRequest,
  RuntimePermissionService,
  RuntimeUserInputRequest,
  RuntimeUserInputService,
} from './sdk-runtime.js';

/** Only the registry operations the Interaction surface needs. */
export interface ClientInteractionRegistries {
  readonly userInputs: Pick<RuntimeUserInputService, 'listPending' | 'respond' | 'dismiss'>;
  readonly permissions: Pick<RuntimePermissionService, 'listPending' | 'respond'>;
}

function invalidClientInteractionInput(
  message: string,
): Error & { readonly code: 'invalid_input' } {
  return Object.assign(new Error(message), { code: 'invalid_input' as const });
}

export async function listClientInteractions(
  registries: ClientInteractionRegistries,
  filter?: { readonly sessionId?: string },
): Promise<readonly ClientInteraction[]> {
  const [questions, permissions] = await Promise.all([
    registries.userInputs.listPending(filter),
    registries.permissions.listPending(filter),
  ]);
  return [
    ...questions.map(toQuestionInteraction),
    ...permissions.map(toPermissionInteraction),
  ];
}

/** Answer one pending interaction by precise id; only the first valid answer counts. */
export async function respondToClientInteraction(
  registries: ClientInteractionRegistries,
  requestId: string,
  response: ClientInteractionResponse,
): Promise<ClientInteractionResult> {
  const pendingQuestion = (await registries.userInputs.listPending())
    .find((request) => request.id === requestId);
  if (pendingQuestion !== undefined) {
    if (response.kind === 'cancel') return registries.userInputs.dismiss(requestId);
    if (response.kind === 'question' && pendingQuestion.kind === 'askUser') {
      return registries.userInputs.respond(requestId, response.answer);
    }
    if (response.kind === 'question_multi' && pendingQuestion.kind === 'askUserMulti') {
      return registries.userInputs.respond(requestId, response.answers);
    }
    if (response.kind === 'question_input' && pendingQuestion.kind === 'askUserInput') {
      return registries.userInputs.respond(requestId, response.text);
    }
    throw invalidClientInteractionInput(
      `Response kind '${response.kind}' does not match pending question kind '${pendingQuestion.kind}'.`,
    );
  }
  const pendingPermission = (await registries.permissions.listPending())
    .find((request) => request.id === requestId);
  if (pendingPermission === undefined) {
    return { requestId, accepted: false, status: 'already_resolved' };
  }
  if (response.kind === 'cancel') {
    const cancelled = await registries.permissions.respond(requestId, {
      type: 'reject',
      reason: response.reason ?? 'Cancelled by user.',
    });
    return cancelled
      ? { requestId, accepted: true, status: 'dismissed' }
      : { requestId, accepted: false, status: 'already_resolved' };
  }
  if (response.kind !== 'permission') {
    throw invalidClientInteractionInput(
      `Response kind '${response.kind}' does not match pending permission request '${pendingPermission.toolName}'.`,
    );
  }
  const accepted = await registries.permissions.respond(
    requestId,
    toRuntimePermissionDecision(response.decision),
  );
  return accepted
    ? { requestId, accepted: true, status: 'answered' }
    : { requestId, accepted: false, status: 'already_resolved' };
}

function toQuestionInteraction(request: RuntimeUserInputRequest): ClientInteraction {
  const base = {
    requestId: request.id,
    sessionId: request.sessionId,
    runId: request.runId,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
  // Options originate from the Host's own tool wiring (ask_user_question and
  // the MCP elicitation mapping), so the payload is trusted at this boundary.
  if (request.kind === 'askUser') {
    return { ...base, kind: 'question', options: request.options as AskUserQuestionOptions };
  }
  if (request.kind === 'askUserMulti') {
    return { ...base, kind: 'question_multi', options: request.options as AskUserMultiOptions };
  }
  return {
    ...base,
    kind: 'question_input',
    options: request.options as { question: string; default?: string },
  };
}

function toPermissionInteraction(request: RuntimePermissionRequest): ClientInteraction {
  return {
    requestId: request.id,
    sessionId: request.sessionId,
    runId: request.runId,
    createdAt: request.createdAt,
    ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
    kind: 'permission',
    options: {
      toolName: request.toolName,
      ...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
      ...(request.risk !== undefined ? { risk: request.risk } : {}),
      ...(request.inputPreview !== undefined ? { inputPreview: request.inputPreview } : {}),
      ...(request.executionCwd !== undefined ? { executionCwd: request.executionCwd } : {}),
      ...(request.grantSuggestions !== undefined ? { grantSuggestions: request.grantSuggestions } : {}),
    },
  };
}

function toRuntimePermissionDecision(
  decision: ClientPermissionDecision,
): RuntimePermissionDecision {
  // The wire schema and this guard both validate the decision: an unknown
  // variant must never consume a first-answer slot or settle a request.
  if (decision.type === 'allow_once') return { type: 'allow_once' };
  if (decision.type === 'allow_session' || decision.type === 'allow_always') {
    if (typeof decision.suggestionId !== 'string' || decision.suggestionId.length === 0) {
      throw invalidClientInteractionInput(
        `Permission decision ${decision.type} requires the request's suggestionId.`,
      );
    }
    return decision.type === 'allow_session'
      ? { type: 'allow_session', suggestionId: decision.suggestionId }
      : { type: 'allow_always', suggestionId: decision.suggestionId };
  }
  if (decision.type === 'reject') {
    return {
      type: 'reject',
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    };
  }
  throw invalidClientInteractionInput(
    `Unknown permission decision: ${JSON.stringify(decision)}.`,
  );
}

/**
 * Back-mapping for daemon-client facades that still expose the registry-shaped
 * members: the wire only carries the typed Interaction RPCs (the old
 * permission and user_input aliases are retired), so these views rebuild the
 * registry payloads from interaction.list.
 */
export function toRuntimeUserInputRequest(
  interaction: ClientInteraction,
): RuntimeUserInputRequest | null {
  if (interaction.kind === 'permission') return null;
  const base = {
    id: interaction.requestId,
    // Synthetic: the interaction path carries no revision; the registry never
    // bumps one today, so 0 is the only value a caller can legitimately echo.
    revision: 0,
    sessionId: interaction.sessionId,
    runId: interaction.runId,
    createdAt: interaction.createdAt,
    expiresAt: interaction.expiresAt,
  };
  if (interaction.kind === 'question') {
    return { ...base, kind: 'askUser', options: interaction.options };
  }
  if (interaction.kind === 'question_multi') {
    return { ...base, kind: 'askUserMulti', options: interaction.options };
  }
  return { ...base, kind: 'askUserInput', options: interaction.options };
}

export function toRuntimePermissionRequest(
  interaction: ClientInteraction,
): RuntimePermissionRequest | null {
  if (interaction.kind !== 'permission') return null;
  return {
    id: interaction.requestId,
    sessionId: interaction.sessionId,
    runId: interaction.runId,
    ...(interaction.options.toolCallId !== undefined ? { toolCallId: interaction.options.toolCallId } : {}),
    toolName: interaction.options.toolName,
    ...(interaction.options.reason !== undefined ? { reason: interaction.options.reason } : {}),
    ...(interaction.options.risk !== undefined ? { risk: interaction.options.risk } : {}),
    ...(interaction.options.inputPreview !== undefined ? { inputPreview: interaction.options.inputPreview } : {}),
    ...(interaction.options.executionCwd !== undefined ? { executionCwd: interaction.options.executionCwd } : {}),
    ...(interaction.options.grantSuggestions !== undefined ? { grantSuggestions: interaction.options.grantSuggestions } : {}),
    createdAt: interaction.createdAt,
    ...(interaction.expiresAt !== undefined ? { expiresAt: interaction.expiresAt } : {}),
  };
}
