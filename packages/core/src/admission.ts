/**
 * Layer A Primitive: Quality Invariant + Admission Contract types.
 *
 * FEATURE_101 (v0.7.31) — types-only module. Runner.admit() runtime lives
 * in `./runner.ts`; the seven (+1 external) invariant implementations live
 * in `@kodax/coding/src/agent-runtime/invariants/`.
 *
 * Why types-only here: the admission contract is a Layer A primitive that
 * @kodax/coding consumes — putting it in @kodax/core keeps SDK consumers
 * from pulling in coding-specific imports just to reference admission
 * types. The actual invariant implementations need access to mutation
 * trackers, budget controllers, and ToolGuardrail capability tiers — all
 * of which live in @kodax/coding — so they belong there.
 *
 * Status: @experimental. v0.7.31 ships these types alongside the FEATURE_089
 * agent-generation consumer; once dispatch eval baseline (FEATURE_101
 * Phase 3) stabilizes the schema we promote to ADR-021.
 *
 * See:
 *   - docs/features/v0.7.31.md#feature_101-constructed-agent-admission-contract
 *   - docs/features/v0.7.31.md#feature_106-ama-harness-selection-calibration
 *     (FEATURE_106 registers the 8th invariant 'harnessSelectionTiming' —
 *      external to admission v1 closed set but uses the same runtime)
 */

import type { Agent } from './agent.js';

// ---------------------------------------------------------------------------
// Manifest = untrusted Agent declaration
// ---------------------------------------------------------------------------

/**
 * Untrusted Agent declaration submitted by an LLM-driven generator
 * (FEATURE_089) or any other consumer that wants the manifest verified
 * by the admission contract before activation.
 *
 * Structurally `Agent` plus three manifest-only optional fields the LLM
 * may declare to express intent (per FEATURE_101 §Manifest schema):
 *
 *   - `requestedToolCapabilities`: "I plan to use bash:test, not bash:network"
 *      Admission intersects with the resolved capability set from `tools`.
 *   - `maxBudget`: "Cap my total turn budget at N" — admission clamps to
 *      `system_cap.maxBudget`; runtime further clamps to parent.remaining.
 *   - `declaredInvariants`: extra invariants the LLM voluntarily binds.
 *      The required set (resolved from role / toolScope / harnessTier) is
 *      ALWAYS a floor — declaredInvariants can only ADD.
 *
 * `Runner.admit(manifest)` reads as "this manifest has not been admitted
 * yet" while `Runner.run(agent, ...)` reads as "this Agent is trusted
 * to execute".
 */
export type AgentManifest = Agent & {
  readonly requestedToolCapabilities?: readonly ToolPermission[];
  readonly maxBudget?: number;
  readonly declaredInvariants?: readonly InvariantId[];
};

// ---------------------------------------------------------------------------
// Tool capability tier (FEATURE_101 §Tool Capability Tier)
// ---------------------------------------------------------------------------

/**
 * Coarse-grained capability classes that group concrete tools by their
 * observable side effects. Replaces the v0.7.30 `ToolName[]` allow-list
 * with semantic categories so admission can reason about "this manifest
 * wants bash:network capability" without enumerating every concrete tool.
 *
 * Aligned with FEATURE_092 (Auto Mode Classifier, v0.7.33) and FEATURE_094
 * (anti-escape, v0.7.36) which both classify tools along these axes.
 */
export type ToolCapability =
  | 'read'
  | 'edit'
  | 'bash:test'
  | 'bash:read-only'
  | 'bash:mutating'
  | 'bash:network'
  | 'subagent';

/**
 * Per-tool capability declaration. Used in `AgentManifest.requestedToolCapabilities`
 * (an optional field manifests can declare to express intent — admission
 * intersects with the resolved capability set).
 */
export interface ToolPermission {
  readonly tool: string;
  readonly capabilities: readonly ToolCapability[];
}

// ---------------------------------------------------------------------------
// Invariant identity (FEATURE_101 §第一版 Invariant 清单 7 项 + FEATURE_106 +1)
// ---------------------------------------------------------------------------

/**
 * Quality invariant identifier.
 *
 * **Admission contract v1 closed set (7 ids)** — FEATURE_101 itself enforces
 * exactly these on every untrusted manifest:
 *
 *   - 'finalOwner'           Manifest must designate a final owner role
 *   - 'handoffLegality'      Handoff graph (manifest + activated agents) is acyclic
 *   - 'budgetCeiling'        manifest.maxBudget ≤ system_cap; runtime clamp to parent
 *   - 'toolPermission'       Resolved capabilities ⊆ system_cap; runtime clamp to parent
 *   - 'evidenceTrail'        Mutations must leave evidence; terminal verifies completeness
 *   - 'boundedRevise'        maxIterations ≤ system; runtime tracks revise count
 *   - 'independentReview'    Verifier role bound; verifier can't read generator reasoning
 *
 * **External consumers (open-ended) — registered to invariant runtime but
 * NOT in admission v1 closed set**:
 *
 *   - 'harnessSelectionTiming'   FEATURE_106 (v0.7.31) — multi-file mutations
 *                                 must be preceded by an emitted harness verdict
 *
 * The runtime is open: future features may register additional invariants.
 * The closed-set guarantee (7) applies to admission v1 only — see
 * docs/features/v0.7.31.md FEATURE_101 §第一版 Invariant 清单 注脚.
 */
export type InvariantId =
  // Admission v1 closed set
  | 'finalOwner'
  | 'handoffLegality'
  | 'budgetCeiling'
  | 'toolPermission'
  | 'evidenceTrail'
  | 'boundedRevise'
  | 'independentReview'
  // External consumer (FEATURE_106)
  | 'harnessSelectionTiming';

// ---------------------------------------------------------------------------
// Invariant result + patch
// ---------------------------------------------------------------------------

/**
 * Patch the admission layer applies when an invariant returns severity='clamp'.
 * Pure data — Runner applies it via a single deterministic reducer (see
 * `applyManifestPatch` in `./admission-patch.ts`).
 *
 * Empty / undefined fields mean "no change". Multiple patches compose by
 * union (removeTools concatenates, clamp* picks min, addInvariants unions).
 */
export interface ManifestPatch {
  readonly removeTools?: readonly string[];
  readonly clampMaxBudget?: number;
  readonly clampMaxIterations?: number;
  readonly addInvariants?: readonly InvariantId[];
  readonly notes?: readonly string[];
}

/**
 * Three-severity result returned by every invariant hook (admit / observe /
 * assertTerminal):
 *
 *   - `ok: true`              No violation. Runner continues.
 *   - `severity: 'reject'`    Hard violation. Admission fails (admit-time)
 *                             or runtime escalates (observe/terminal-time).
 *   - `severity: 'clamp'`     Manifest is over-broad. Admission applies the
 *                             attached `patch` and admits with a warning.
 *                             clamp severity ONLY makes sense at admit-time;
 *                             observe/terminal hooks should use 'warn' or
 *                             'reject'.
 *   - `severity: 'warn'`      Log-only signal. Runner records to trace +
 *                             dispatch-eval metric, no action taken.
 *
 * The discriminated union pattern lets TypeScript narrow `patch` to only
 * be present on clamp results — callers can't forget to check.
 */
export type InvariantResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly severity: 'reject'; readonly reason: string }
  | {
      readonly ok: false;
      readonly severity: 'clamp';
      readonly reason: string;
      readonly patch: ManifestPatch;
    }
  | { readonly ok: false; readonly severity: 'warn'; readonly reason: string };

// ---------------------------------------------------------------------------
// Hook contexts
// ---------------------------------------------------------------------------

/**
 * System-wide caps the admission layer enforces against. The Runner
 * resolves these from configuration once at startup (or per-call when
 * the SDK consumer overrides via Runner.admit options).
 *
 * `maxBudget` / `maxIterations` are activation caps — runtime clamps to
 * parent.remaining via the budget controller (separate concern).
 * `allowedToolCapabilities` is the union of capabilities the system
 * permits ANY constructed agent to request (intersected with
 * manifest.requestedToolCapabilities at admission time).
 */
export interface SystemCap {
  readonly maxBudget: number;
  readonly maxIterations: number;
  readonly allowedToolCapabilities: readonly ToolCapability[];
}

/**
 * Context passed to invariant.admit() hooks at admission time.
 *
 * `activatedAgents` is the global set of already-admitted constructed
 * agents — used by `handoffLegality` for transitive cycle detection
 * (handoffs reference these by name).
 *
 * `stagedAgents` is the set of manifests that have been staged in the
 * current generation batch but are not yet activated. FEATURE_101
 * v0.7.31.1 patch: `handoffLegality` consults both maps so a same-batch
 * cycle (A→B + B→A staged together, neither yet activated) is rejected
 * at admission time instead of slipping through. The map is
 * intentionally separate from `activatedAgents` so invariants that
 * only care about already-running agents (future work) can still
 * distinguish.
 *
 * Frozen at admission entry; invariants must not mutate.
 */
export interface AdmissionCtx {
  readonly manifest: AgentManifest;
  readonly activatedAgents: ReadonlyMap<string, Agent>;
  readonly stagedAgents: ReadonlyMap<string, Agent>;
  readonly systemCap: SystemCap;
}

/**
 * Runtime event fed to invariant.observe() during agent execution.
 * Discriminated by `kind` so each invariant only narrows on what it
 * cares about (e.g. `harnessSelectionTiming` only inspects
 * `mutation_recorded` events).
 */
export type RunnerEvent =
  | { readonly kind: 'tool_call'; readonly toolName: string; readonly capability?: ToolCapability }
  | { readonly kind: 'mutation_recorded'; readonly file: string; readonly fileCount: number }
  | { readonly kind: 'handoff_taken'; readonly target: string }
  | { readonly kind: 'revise_count'; readonly harness: string; readonly count: number }
  | { readonly kind: 'evidence_added'; readonly artifactPath: string };

/**
 * Read-only view of the per-run mutation tracker. Invariant observe hooks
 * may inspect but never mutate. (The full @kodax/coding mutation tracker
 * has additional fields like per-file line deltas — those are the coding
 * package's concern, not the Layer A primitive.)
 */
export interface ReadonlyMutationTracker {
  readonly files: ReadonlySet<string>;
  readonly totalOps: number;
}

/**
 * Recorder slice exposed to observe hooks for cross-event correlation.
 * Kept minimal — invariants that need richer state should manage their
 * own per-instance counters and use the recorder only for shared
 * "did Scout commit a harness verdict yet?" signal.
 */
export interface ReadonlyRecorder {
  readonly scout?: {
    readonly payload?: {
      readonly scout?: {
        readonly confirmedHarness?: string;
      };
    };
  };
}

export interface ObserveCtx {
  readonly manifest: AgentManifest;
  readonly mutationTracker: ReadonlyMutationTracker;
  readonly recorder: ReadonlyRecorder;
}

/**
 * Terminal-time deliverable inspected by invariant.assertTerminal hooks.
 *
 * `verdict` is set when an Evaluator role emitted a verdict; undefined
 * for H0 runs that bypass evaluation. `evidenceArtifacts` enumerates the
 * artifact files produced during the run (per-mutation evidence,
 * verification reports, etc.).
 */
export interface Deliverable {
  readonly evidenceArtifacts: readonly string[];
  readonly verdict?: 'accept' | 'revise' | 'blocked';
  readonly mutationCount: number;
}

export interface TerminalCtx {
  readonly manifest: AgentManifest;
  readonly deliverable: Deliverable;
}

// ---------------------------------------------------------------------------
// Quality Invariant declaration
// ---------------------------------------------------------------------------

/**
 * Quality Invariant declaration. An invariant declares which of the three
 * hook points it implements (admit / observe / assertTerminal) — at least
 * one of the three must be present.
 *
 * Invariants are registered to the runtime via `registerInvariant()` (in
 * `./admission.ts` once Runner.admit lands). The runtime maintains a
 * static registry indexed by `InvariantId`; `Runner.admit` resolves the
 * required set per (role, toolScope, harnessTier) tuple and applies all
 * relevant admit hooks.
 *
 * Invariants must be pure functions of their inputs. Side effects
 * (writing trace, sending events) happen in the Runner shell, not inside
 * the invariant body.
 */
export interface QualityInvariant {
  readonly id: InvariantId;
  readonly description: string;
  admit?(manifest: AgentManifest, ctx: AdmissionCtx): InvariantResult;
  observe?(event: RunnerEvent, ctx: ObserveCtx): InvariantResult;
  assertTerminal?(deliverable: Deliverable, ctx: TerminalCtx): InvariantResult;
}

// ---------------------------------------------------------------------------
// Admission verdict
// ---------------------------------------------------------------------------

/**
 * Opaque handle produced by `Runner.admit()` on success. Required input
 * to `ConstructionRuntime.activate()` — prevents activate from being
 * called on a manifest that hasn't gone through admission.
 *
 * `appliedPatches` records every clamp the admission applied; consumers
 * can inspect to surface "what was modified vs the manifest you submitted".
 * `invariantBindings` lists the invariants registered against this
 * admitted agent (effective set = required ∪ declared).
 */
export interface AdmittedHandle {
  readonly manifest: AgentManifest;
  readonly admittedAt: string;
  readonly appliedPatches: readonly ManifestPatch[];
  readonly invariantBindings: readonly InvariantId[];
}

/**
 * Admission verdict — discriminated union so TypeScript can narrow
 * `handle` (only present on success) vs `reason` (only on failure).
 *
 * `retryable` on failure indicates whether the generator should be asked
 * to fix and retry (schema invalid / DAG cycle) vs hard reject (system
 * cap violated past clamp tolerance).
 */
export type AdmissionVerdict =
  | {
      readonly ok: true;
      readonly handle: AdmittedHandle;
      readonly clampNotes: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly retryable: boolean;
    };
