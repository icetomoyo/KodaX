/**
 * FEATURE_101 (v0.7.31.1) — admission session: runtime dispatch of
 * `observe` and `assertTerminal` invariant hooks.
 *
 * The v0.7.31 release shipped only the `admit` hook wired into
 * `Runner.admit`. The three-segment hook model (admit / observe /
 * assertTerminal) declared in FEATURE_101 §三段 hook 模型 had its
 * other two thirds defined as types but never invoked at runtime —
 * meaning every invariant that depended on observe / terminal
 * (`evidenceTrail`, `independentReview`, `boundedRevise`,
 * `harnessSelectionTiming`) was effectively dormant after admission.
 *
 * This module fills that gap with two pieces:
 *
 *   1. A WeakMap-backed binding registry (`setAdmittedAgentBindings` /
 *      `getAdmittedAgentBindings`) so `Runner.run` can recover the
 *      InvariantId set associated with an admitted agent without a
 *      compile-time dependency from `agent.ts` onto `admission.ts`
 *      (which would re-introduce the import cycle the original split
 *      avoided).
 *   2. `InvariantSession`: a per-run event router. The Runner creates
 *      one when an agent has bindings, and threads `record*` calls
 *      through it during the run. The session dispatches observe to
 *      bound invariants and accumulates violations; assertTerminal
 *      runs once at end.
 *
 * Pure runtime — no I/O. The session does not log or trace; the Runner
 * shell decides what to do with returned violation results
 * (typically: trace span for `warn`, throw for `reject`, accumulate
 * patches for `clamp` though clamp is admit-time only).
 */

import type { Agent } from './agent.js';
import { getInvariant } from './admission-runtime.js';
import { _incInvariantViolation } from './admission-metrics.js';
import type {
  AgentManifest,
  Deliverable,
  InvariantId,
  InvariantResult,
  ObserveCtx,
  ReadonlyMutationTracker,
  ReadonlyRecorder,
  RunnerEvent,
  TerminalCtx,
  ToolCapability,
} from './admission.js';

// ---------------------------------------------------------------------------
// Agent ↔ bindings registry (WeakMap so GC tracks agent lifetimes naturally)
// ---------------------------------------------------------------------------

interface AdmittedAgentMeta {
  readonly bindings: readonly InvariantId[];
  readonly manifest: AgentManifest;
}

const _bindings = new WeakMap<Agent, AdmittedAgentMeta>();

/**
 * Associate an admitted manifest's invariant bindings with the runtime
 * Agent the consumer uses. Set by `ConstructionRuntime.activate` after
 * `Runner.admit` succeeds; SDK consumers calling `Runner.run` directly
 * on hand-authored Agents leave this unset and skip runtime invariant
 * dispatch entirely.
 */
export function setAdmittedAgentBindings(
  agent: Agent,
  manifest: AgentManifest,
  bindings: readonly InvariantId[],
): void {
  _bindings.set(agent, { bindings, manifest });
}

/**
 * Look up bindings for an agent. Returns undefined when the agent was
 * never admitted (trusted SDK / preset path).
 */
export function getAdmittedAgentBindings(
  agent: Agent,
): { readonly bindings: readonly InvariantId[]; readonly manifest: AgentManifest } | undefined {
  return _bindings.get(agent);
}

/**
 * Test-only — clears the registry. Production code should never call
 * this; the WeakMap entries are reclaimed naturally when agents fall
 * out of scope.
 */
export function _resetAdmittedAgentBindings(agent: Agent): void {
  _bindings.delete(agent);
}

// ---------------------------------------------------------------------------
// Mutation tracker — tiny mutable buffer that the session exposes via the
// ReadonlyMutationTracker interface to invariant.observe hooks.
// ---------------------------------------------------------------------------

class MutableMutationTracker {
  readonly files = new Set<string>();
  totalOps = 0;

  record(file: string): void {
    this.files.add(file);
    this.totalOps += 1;
  }
}

class MutableRecorder {
  scout?: ReadonlyRecorder['scout'];

  setConfirmedHarness(harness: string): void {
    this.scout = { payload: { scout: { confirmedHarness: harness } } };
  }
}

// ---------------------------------------------------------------------------
// InvariantSession — the per-run event router.
// ---------------------------------------------------------------------------

/**
 * Severity surface returned by `recordX` calls. A `reject` from
 * observe means the run must abort; the Runner shell raises an error.
 * A `warn` is informational — the Runner records it but continues.
 * `ok` is the no-op success case.
 */
export interface SessionDispatchResult {
  readonly results: readonly { readonly id: InvariantId; readonly result: InvariantResult }[];
}

/**
 * Per-run state machine + event router. Constructed once at the start
 * of a run (inside `Runner.run`) when the start agent has bindings.
 * The Runner threads tool / handoff / mutation events through the
 * `record*` API; the session fans them out to bound invariants.
 *
 * Threading rules (so the data stays valid):
 *   - `recordX` calls return synchronously; observe hooks are pure
 *     functions of the immutable event payload + read-only context.
 *   - `assertTerminal` must be called exactly once at run end. The
 *     Runner is responsible for honoring this.
 *   - The session is single-run; spawning a sub-run (handoff /
 *     dispatch_child_task) creates a fresh session for the target.
 *
 * The session is never exposed across module boundaries — it lives in
 * the Runner closure and dies when the run ends. WeakMap is overkill
 * for state that is by-construction scoped; plain fields suffice.
 */
export class InvariantSession {
  private readonly bindings: readonly InvariantId[];
  private readonly manifest: AgentManifest;
  private readonly mutations = new MutableMutationTracker();
  private readonly recorder = new MutableRecorder();
  private verdict: 'accept' | 'revise' | 'blocked' | undefined;
  private readonly evidenceArtifacts: string[] = [];
  private readonly violations: { readonly id: InvariantId; readonly result: InvariantResult }[] = [];
  private terminalRan = false;

  constructor(bindings: readonly InvariantId[], manifest: AgentManifest) {
    this.bindings = bindings;
    this.manifest = manifest;
  }

  // -------------------------------------------------------------------------
  // observe-time event recorders. Each builds the appropriate RunnerEvent
  // and dispatches to all bound invariants whose `observe` hook is set.
  // -------------------------------------------------------------------------

  recordToolCall(toolName: string, capability?: ToolCapability): SessionDispatchResult {
    const event: RunnerEvent =
      capability !== undefined
        ? { kind: 'tool_call', toolName, capability }
        : { kind: 'tool_call', toolName };
    return this.dispatchObserve(event);
  }

  recordHandoff(target: string): SessionDispatchResult {
    return this.dispatchObserve({ kind: 'handoff_taken', target });
  }

  /**
   * Record a file mutation. `fileCount` is the cumulative distinct-file
   * total (mirrors `harnessSelectionTiming` ObserveCtx contract). The
   * session computes it from its internal MutableMutationTracker so
   * callers don't need to track it.
   */
  recordMutation(file: string): SessionDispatchResult {
    this.mutations.record(file);
    return this.dispatchObserve({
      kind: 'mutation_recorded',
      file,
      fileCount: this.mutations.files.size,
    });
  }

  recordEvidence(artifactPath: string): SessionDispatchResult {
    this.evidenceArtifacts.push(artifactPath);
    return this.dispatchObserve({ kind: 'evidence_added', artifactPath });
  }

  recordRevise(harness: string, count: number): SessionDispatchResult {
    return this.dispatchObserve({ kind: 'revise_count', harness, count });
  }

  /**
   * Record the Scout's confirmed-harness signal — drives
   * `harnessSelectionTiming.observe`'s "did Scout commit a harness
   * verdict yet?" check. Coding-side surface invokes this after the
   * scout role emits its verdict.
   */
  setConfirmedHarness(harness: string): void {
    this.recorder.setConfirmedHarness(harness);
  }

  setVerdict(verdict: 'accept' | 'revise' | 'blocked'): void {
    this.verdict = verdict;
  }

  // -------------------------------------------------------------------------
  // Inspection — read-only views for the Runner shell.
  // -------------------------------------------------------------------------

  /** @internal Test inspection + Runner trace surface. */
  getViolations(): readonly { readonly id: InvariantId; readonly result: InvariantResult }[] {
    return [...this.violations];
  }

  getMutationCount(): number {
    return this.mutations.files.size;
  }

  getEvidenceArtifacts(): readonly string[] {
    return [...this.evidenceArtifacts];
  }

  // -------------------------------------------------------------------------
  // assertTerminal — fire-once at run end.
  // -------------------------------------------------------------------------

  /**
   * Run all bound invariants' `assertTerminal` hooks. Caller must
   * invoke exactly once; subsequent calls are no-ops (returns the
   * accumulated violations from the first call). Returns the
   * union of violations gathered during observe + this terminal pass.
   */
  assertTerminal(): SessionDispatchResult {
    if (this.terminalRan) {
      return { results: this.getViolations() };
    }
    this.terminalRan = true;

    const deliverable: Deliverable = {
      evidenceArtifacts: [...this.evidenceArtifacts],
      verdict: this.verdict,
      mutationCount: this.mutations.files.size,
    };
    const ctx: TerminalCtx = { manifest: this.manifest, deliverable };

    const out: { readonly id: InvariantId; readonly result: InvariantResult }[] = [];
    for (const id of this.bindings) {
      const inv = getInvariant(id);
      if (!inv?.assertTerminal) continue;
      const result = inv.assertTerminal(deliverable, ctx);
      if (!result.ok) {
        const entry = { id, result } as const;
        this.violations.push(entry);
        out.push(entry);
        _incInvariantViolation('terminal');
      }
    }
    return { results: out };
  }

  // -------------------------------------------------------------------------
  // Internal — invariant.observe dispatch.
  // -------------------------------------------------------------------------

  private dispatchObserve(event: RunnerEvent): SessionDispatchResult {
    const ctx: ObserveCtx = {
      manifest: this.manifest,
      mutationTracker: this.mutations as ReadonlyMutationTracker,
      recorder: this.recorder,
    };
    const out: { readonly id: InvariantId; readonly result: InvariantResult }[] = [];
    for (const id of this.bindings) {
      const inv = getInvariant(id);
      if (!inv?.observe) continue;
      const result = inv.observe(event, ctx);
      if (!result.ok) {
        const entry = { id, result } as const;
        this.violations.push(entry);
        out.push(entry);
        _incInvariantViolation('observe');
      }
    }
    return { results: out };
  }
}

/**
 * Construct a session for an agent if it has admission bindings, or
 * return undefined for trusted (un-admitted) agents — the Runner
 * checks the return value and skips invariant dispatch entirely when
 * undefined, keeping the trusted-path zero-overhead.
 */
export function createInvariantSessionForAgent(agent: Agent): InvariantSession | undefined {
  const meta = getAdmittedAgentBindings(agent);
  if (!meta) return undefined;
  return new InvariantSession(meta.bindings, meta.manifest);
}
