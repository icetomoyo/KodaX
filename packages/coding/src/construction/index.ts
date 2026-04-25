/**
 * KodaX Construction Runtime — public surface.
 *
 * FEATURE_087 + FEATURE_088 (v0.7.28). See:
 *   - docs/features/v0.7.28.md — design.
 *   - docs/DD.md §14 — runtime contract.
 */

// Types
export type {
  ConstructionArtifact,
  ArtifactStatus,
  Capabilities,
  ConstructionPolicy,
  ConstructionPolicyVerdict,
  ScriptSource,
  StagedHandle,
  TestResult,
  ToolContent,
} from './types.js';

export {
  CapabilityDeniedError,
  ConstructionManifestError,
  DEFAULT_HANDLER_TIMEOUT_MS,
  defaultPolicy,
} from './types.js';

// Lifecycle (module-singleton).
// Note: internal function names `test` and `list` are renamed at the
// public boundary to `testArtifact` and `listArtifacts` to avoid clashes
// with vitest's global `test` and JS's frequent `list` identifier.
export {
  configureRuntime,
  stage,
  test as testArtifact,
  activate,
  revoke,
  list as listArtifacts,
  readArtifact,
  rehydrateActiveArtifacts,
  _resetRuntimeForTesting,
} from './runtime.js';

// View-layer
export { listConstructed, findByVersion, listAll } from './views.js';

// Lower-level building blocks (for advanced callers / tests)
export { loadHandler } from './load-handler.js';
export type { LoadHandlerOptions, LoadHandlerScope } from './load-handler.js';
export { createCtxProxy } from './ctx-proxy.js';
export type { CreateCtxProxyOptions } from './ctx-proxy.js';

// Phase 2: static-check pipeline pieces — exposed for consumers that
// want to invoke individual stages outside ConstructionRuntime.test().
export { runAstRules } from './ast-rules.js';
export type { AstCheckResult, AstRuleId, AstRuleViolation } from './ast-rules.js';

export { validateToolSchemaForProvider } from './provider-schema.js';
export type {
  SchemaProvider,
  SchemaValidationResult,
} from './provider-schema.js';

export {
  buildLlmReviewPrompt,
  parseLlmReviewVerdict,
  runLlmReview,
} from './llm-review.js';
export type {
  BuildPromptInput,
  LlmReviewClient,
  LlmReviewResult,
  LlmReviewVerdict,
} from './llm-review.js';

export type { TestArtifactOptions } from './runtime.js';
