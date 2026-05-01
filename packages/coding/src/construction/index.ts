/**
 * KodaX Construction Runtime — public surface.
 *
 * FEATURE_087 + FEATURE_088 (v0.7.28). See:
 *   - docs/features/v0.7.28.md — design.
 *   - docs/DD.md §14 — runtime contract.
 */

// Types
export type {
  AgentArtifact,
  AgentContent,
  AgentHandoffRef,
  AgentReasoningRef,
  AgentTestCase,
  ConstructionArtifact,
  ArtifactStatus,
  Capabilities,
  ConstructionPolicy,
  ConstructionPolicyVerdict,
  GuardrailRef,
  ScriptSource,
  StagedHandle,
  TestResult,
  ToolArtifact,
  ToolContent,
  ToolRef,
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
  getRuntimeCwd,
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

// FEATURE_089 (v0.7.31) — Constructed Agent Resolver. Activated
// `kind: 'agent'` artifacts register here so consumers can lookup
// runnable Agent objects by name.
//
// FEATURE_090 (v0.7.32) adds `drainPendingSwaps` + `hasPendingSwap`
// for the deferred swap mechanism — REPL bootstrap calls drain after
// each top-level Runner.run terminates so self-modify activations
// stay shielded from the run that triggered them.
export {
  _resetAgentResolverForTesting,
  drainPendingSwaps,
  hasPendingSwap,
  listConstructedAgents,
  registerConstructedAgent,
  resolveConstructedAgent,
} from './agent-resolver.js';

// FEATURE_089 admission bridge — exposed so SDK consumers can
// pre-validate manifests outside the `test()` lifecycle.
export {
  buildAdmissionManifest,
  parseToolNameFromRef,
} from './admission-bridge.js';

// FEATURE_089 Phase 3.5 — sandbox runner.
export {
  runSandboxAgentTest,
} from './sandbox-runner.js';
export type {
  SandboxCaseResult,
  SandboxLlmCallback,
  SandboxRunResult,
  SandboxRunnerOptions,
} from './sandbox-runner.js';

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

export type {
  TestArtifactOptions,
  SelfModifyAskUser,
  SelfModifyAskUserInput,
} from './runtime.js';

// FEATURE_090 (v0.7.32) — external surface for REPL bootstrap + CLI
// consumers. Internal helpers (validation, summary build/parse,
// diffHash, consumeBudget) stay package-private — peers inside
// `construction/` and the FEATURE_090 tool import them via relative
// paths instead.
//
// `appendAuditEntry` is re-exported because the CLI surface
// (`self_modify_cli.ts`) records FEATURE_090 lifecycle events from
// three distinct commands (reset-budget, rollback, disable-self-
// modify) — the 3+-case threshold for justifying public exposure.
export { appendAuditEntry, readAuditEntries } from './audit-log.js';
export type { AuditEntry, AuditEventKind } from './audit-log.js';
export {
  DEFAULT_SELF_MODIFY_BUDGET,
  readBudget,
  resetBudget,
  remaining as remainingSelfModifyBudget,
} from './budget.js';
export type { BudgetState } from './budget.js';
export {
  disableSelfModify,
  readDisableState,
} from './disable-state.js';
export type { DisableState } from './disable-state.js';
export { rollbackSelfModify } from './rollback.js';
export type { RollbackResult } from './rollback.js';
export type {
  SelfModifyDiffSummary,
  SelfModifyDiffSeverity,
} from './self-modify-summary.js';
