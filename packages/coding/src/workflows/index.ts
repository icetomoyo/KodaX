/**
 * FEATURE_217 (v0.7.49) — `@kodax-ai/coding` workflows barrel.
 *
 * Exposes the workflow agent backend (Phase B), the built-in read-only
 * workflows (Phase C), and a name-keyed registry the REPL `/workflow`
 * command (Phase D) resolves against.
 */

export * from './agent-adapter.js';
export * from './builtin/parallel-investigation.js';
export * from './builtin/scoped-review.js';
// BUILTIN_WORKFLOWS / getBuiltinWorkflow / listBuiltinWorkflows live in the leaf
// registry so the nested-workflow resolver (workflow-runner) can read them
// without the index → workflow-runner re-export cycle.
export * from './builtin/registry.js';
export * from './run-graph.js';
export * from './workflow-runner.js';
export * from './discovery.js';
export * from './run-manager.js';
export * from './lifecycle-controller.js';
export * from './generator.js';
export * from './pattern-templates.js';
export * from './invocation-policy.js';
export * from './identity.js';
export * from './host.js';
export * from './author-via-worker.js';
export * from './review-packet.js';
export * from './scoped-review.js';
export * from './cost-report.js';
export { completeWorkflowRunCleanup, recoverWorkflowRunCleanups } from './cleanup.js';
export { protectWorkflowProject, withWorkflowWorktreeProtection, isWorkflowProjectProtected } from './project-protection.js';
