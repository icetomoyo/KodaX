export interface ReplRuntimePermissionGrantSuggestion {
  readonly id: string;
  readonly kind: 'session' | 'persistent';
  readonly label: string;
}

export interface ReplRuntimePermissionRequest {
  readonly id: string;
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly reason?: string;
  readonly risk?: 'low' | 'medium' | 'high';
  readonly executionCwd?: string;
  readonly grantSuggestions?: readonly ReplRuntimePermissionGrantSuggestion[];
  readonly createdAt?: string;
  readonly expiresAt?: string;
}

export interface ReplRuntimePermissionPromptContext {
  readonly signal: AbortSignal;
}

export type ReplRuntimePermissionDecision =
  | { readonly type: 'allow_once' }
  | { readonly type: 'allow_session'; readonly suggestionId: string }
  | { readonly type: 'allow_always'; readonly suggestionId: string }
  | { readonly type: 'reject'; readonly reason?: string };

export type ReplRuntimePermissionPrompt = (
  request: ReplRuntimePermissionRequest,
  context: ReplRuntimePermissionPromptContext,
) => Promise<ReplRuntimePermissionDecision>;

export const RUNTIME_PERMISSION_PENDING_NOTICE =
  'Runtime state: run active until this approval is resolved.';

export function resolveReplRuntimePermissionDecision(
  request: ReplRuntimePermissionRequest,
  result: ConfirmResult,
): ReplRuntimePermissionDecision {
  if (!result.confirmed) {
    return { type: 'reject', reason: 'User rejected the tool call.' };
  }
  if (result.runtimeGrantKind === undefined) return { type: 'allow_once' };
  const suggestion = request.grantSuggestions
    ?.find((candidate) => candidate.kind === result.runtimeGrantKind);
  if (!suggestion) {
    return { type: 'reject', reason: 'Runtime grant suggestion expired.' };
  }
  return result.runtimeGrantKind === 'session'
    ? { type: 'allow_session', suggestionId: suggestion.id }
    : { type: 'allow_always', suggestionId: suggestion.id };
}

export interface ReplRuntimeAutoModeControl {
  getStats(sessionId: string): Promise<AutoModeStats | undefined>;
  syncSettings?(
    sessionId: string,
    permissionMode: string,
    settings: ReplRuntimeAutoModeSettings,
  ): Promise<AutoModeStats | undefined>;
  subscribe?(
    sessionId: string,
    listener: (stats: AutoModeStats | undefined) => void,
  ): { close(): void };
}

export interface ReplRuntimeAutoModeSettings {
  readonly classifierModel?: string;
  readonly reviewPolicy?: string;
}

export function toReplRuntimeAutoModeSettings(
  settings: ResolvedAutoModeSettings,
): ReplRuntimeAutoModeSettings {
  const classifierModel = settings.classifierModelEnv ?? settings.classifierModel;
  return {
    ...(classifierModel !== undefined ? { classifierModel } : {}),
    ...(settings.reviewPolicy !== undefined
      ? { reviewPolicy: settings.reviewPolicy }
      : {}),
  };
}
import type { AutoModeStats } from '@kodax-ai/coding';
import type { ResolvedAutoModeSettings } from './common/permission-config.js';
import type { ConfirmResult } from './permission/types.js';
