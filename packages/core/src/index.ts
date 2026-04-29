/**
 * @kodax/core — Layer A primitives.
 *
 * Extracted from `@kodax/coding/src/primitives/*` in FEATURE_082 (v0.7.24).
 * `@kodax/coding` keeps a barrel re-export so batteries-included consumers
 * continue to see the same symbols; that is a permanent convenience, not a
 * deprecation shim.
 *
 * @experimental API shape may adjust until v0.8.0.
 */

export type {
  Agent,
  AgentMessage,
  AgentMiddlewareDeclaration,
  AgentReasoningProfile,
  AgentTool,
  Guardrail,
  Handoff,
  ReasoningDepth,
} from './agent.js';
export { createAgent, createHandoff } from './agent.js';

export type {
  InMemorySessionOptions,
  MessageEntry,
  Session,
  SessionEntry,
  SessionExtension,
  SessionForkOptions,
} from './session.js';
export { createInMemorySession } from './session.js';

export type {
  CompactionContext,
  CompactionEntry,
  CompactionEntryPayload,
  CompactionPolicy,
  CompactionResult,
  DefaultSummaryCompactionOptions,
} from './compaction.js';
export { DefaultSummaryCompaction } from './compaction.js';

export type {
  PresetDispatcher,
  PresetTracingContext,
  RunEvent,
  RunOptions,
  RunResult,
} from './runner.js';
export {
  Runner,
  registerPresetDispatcher,
  _resetPresetDispatchers,
  extractAssistantTextFromMessage,
} from './runner.js';

export type {
  RunnableTool,
  RunnerLlmResult,
  RunnerLlmReturn,
  RunnerToolCall,
  RunnerToolContext,
  RunnerToolObserver,
  RunnerToolResult,
} from './runner-tool-loop.js';
export {
  MAX_TOOL_LOOP_ITERATIONS,
  buildAssistantMessageFromLlmResult,
  buildToolResultMessage,
  executeRunnerToolCall,
  isRunnableTool,
  isRunnerLlmResult,
} from './runner-tool-loop.js';

export type {
  HandoffSignal,
} from './runner-handoff.js';
export {
  detectHandoffSignal,
  emitHandoffSpan,
  replaceSystemMessage,
} from './runner-handoff.js';

export type {
  GuardrailContext,
  GuardrailVerdict,
  InputGuardrail,
  OutputGuardrail,
  ToolBeforeOutcome,
  ToolGuardrail,
} from './guardrail.js';
export {
  GuardrailBlockedError,
  GuardrailEscalateError,
  collectGuardrails,
  runInputGuardrails,
  runOutputGuardrails,
  runToolAfterGuardrails,
  runToolBeforeGuardrails,
} from './guardrail.js';

export {
  SCOUT_AGENT_NAME,
  PLANNER_AGENT_NAME,
  GENERATOR_AGENT_NAME,
  EVALUATOR_AGENT_NAME,
  TASK_ENGINE_ROLE_AGENTS,
  scoutAgent,
  plannerAgent,
  generatorAgent,
  evaluatorAgent,
} from './task-engine-agents.js';

export type {
  CapabilityKind,
  CapabilityProvider,
  CapabilityResult,
} from './capability.js';

// FEATURE_101 (v0.7.31) — Constructed Agent Admission Contract types.
// Runner.admit() runtime + invariant registry are added in subsequent
// 1A.2 / 1A.3 increments; this export only surfaces the data shapes so
// that @kodax/coding can declare invariant implementations against them.
export type {
  AdmissionCtx,
  AdmissionVerdict,
  AdmittedHandle,
  AgentManifest,
  Deliverable,
  InvariantId,
  InvariantResult,
  ManifestPatch,
  ObserveCtx,
  QualityInvariant,
  ReadonlyMutationTracker,
  ReadonlyRecorder,
  RunnerEvent,
  SystemCap,
  TerminalCtx,
  ToolCapability,
  ToolPermission,
} from './admission.js';

export {
  _resetInvariantRegistry,
  applyManifestPatch,
  composePatches,
  getInvariant,
  listRegisteredInvariants,
  registerInvariant,
  resolveEffectiveInvariants,
  resolveRequiredInvariants,
} from './admission-runtime.js';

export type { AdmissionAuditOptions } from './admission-audit.js';
export { DEFAULT_SYSTEM_CAP, runAdmissionAudit } from './admission-audit.js';

// FEATURE_101 v1 pure-new invariants — registered to the shared runtime
// registry via `registerCoreInvariants()`. SDK consumers that want
// admission can either call `registerCoreInvariants()` once at startup
// or import the @kodax/coding bootstrap which registers all 8 invariants
// (4 pure + 4 capability-coupled).
export {
  CORE_INVARIANTS,
  evidenceTrail,
  finalOwner,
  handoffLegality,
  harnessSelectionTiming,
  registerCoreInvariants,
} from './invariants/index.js';
