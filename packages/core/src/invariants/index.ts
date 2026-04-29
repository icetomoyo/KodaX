/**
 * Pure-new invariant implementations bundled with @kodax/core.
 *
 * The admission contract types live in `../admission.ts`; the registry
 * runtime in `../admission-runtime.ts`. This module exports the four
 * invariant declarations plus a `registerCoreInvariants()` helper that
 * registers them in one call.
 *
 * Why this split:
 *   - These four (finalOwner, handoffLegality, evidenceTrail,
 *     harnessSelectionTiming) are pure functions of the admission types
 *     — they have NO @kodax/coding dependencies. Living in @kodax/core
 *     keeps the dependency direction clean and lets `Runner.admit`
 *     unit-test against real invariants without pulling the coding
 *     runtime into the test harness.
 *   - The other four (budgetCeiling, toolPermission, boundedRevise,
 *     independentReview) wrap @kodax/coding capabilities (mutation
 *     tracker, budget controller, ToolGuardrail tier resolver) and live
 *     in `@kodax/coding/src/agent-runtime/invariants/`.
 *
 * Registration is NOT side-effecting on import — consumers call
 * `registerCoreInvariants()` explicitly so test isolation
 * (`_resetInvariantRegistry()` followed by registering only the subset
 * a test needs) stays predictable.
 */

import { registerInvariant } from '../admission-runtime.js';
import type { QualityInvariant } from '../admission.js';
import { evidenceTrail } from './evidence-trail.js';
import { finalOwner } from './final-owner.js';
import { handoffLegality } from './handoff-legality.js';
import { harnessSelectionTiming } from './harness-selection-timing.js';

export { evidenceTrail, finalOwner, handoffLegality, harnessSelectionTiming };

/**
 * The four pure invariants @kodax/core ships, in registration order.
 * Exposed as a constant so consumers can introspect the set without
 * registering (e.g. dispatch-eval metric setup that wants id labels).
 */
export const CORE_INVARIANTS: readonly QualityInvariant[] = [
  finalOwner,
  handoffLegality,
  evidenceTrail,
  harnessSelectionTiming,
];

/**
 * Register the four pure-new invariants on the shared runtime registry.
 * Idempotent only when paired with `_resetInvariantRegistry()` first —
 * `registerInvariant` itself throws on duplicate registration, which is
 * the desired contract (silent overwrite would mask refactors).
 */
export function registerCoreInvariants(): void {
  for (const inv of CORE_INVARIANTS) {
    registerInvariant(inv);
  }
}
