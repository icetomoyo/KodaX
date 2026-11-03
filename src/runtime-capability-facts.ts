import { DEFAULT_CLASSIFIER_TIMEOUT_MS, DEFAULT_CLASSIFIER_RETRY_TIMEOUT_MS } from '@kodax-ai/coding';

/** Current producer facts; minimum client requirements remain independently versioned. */
export const RUNTIME_AUTO_MODE_GUARDRAIL_CAPABILITY = Object.freeze({
  version: 6,
  owner: 'session-runtime',
  sandboxFirst: true,
  sandboxCompletionAuthority: true,
  hostBoundaryReviewOnly: true,
  escalationCreatesPermission: false,
  automaticUserPromptOnDeny: false,
  defaultClassifierTimeoutMs: DEFAULT_CLASSIFIER_TIMEOUT_MS,
  retryClassifierTimeoutMs: DEFAULT_CLASSIFIER_RETRY_TIMEOUT_MS,
  maxClassifierAttempts: 2,
  boundedClassifierInput: true,
  diagnosticsVersion: 1,
  permissionGrantSuggestions: true,
  concretePermissionMatchers: true,
  clientScopeExpansion: false,
  exactTextMutationApproval: true,
  livePermissionContext: true,
} as const);
