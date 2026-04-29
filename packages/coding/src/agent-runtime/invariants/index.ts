/**
 * Capability-coupled invariants registered by @kodax/coding.
 *
 * Pairs with `@kodax/core/invariants/index.ts` (the four pure-new
 * invariants). Together they form the FEATURE_101 admission v1 closed
 * set (8 invariants — 7 admission core + 1 FEATURE_106 external).
 *
 * Why this split (repeated from @kodax/core for symmetry):
 *
 *   - The four pure invariants (finalOwner, handoffLegality,
 *     evidenceTrail, harnessSelectionTiming) are pure functions of
 *     admission types and live in @kodax/core.
 *   - The four coupled invariants (budgetCeiling, toolPermission,
 *     boundedRevise, independentReview) tie into @kodax/coding's
 *     budget controller / tool registry / revise tracker / role
 *     conventions and live here.
 *
 * `registerCodingInvariants()` is the canonical bootstrap entry point
 * — call it once at SDK startup (or in test setup paired with
 * `_resetInvariantRegistry()`). The function also calls
 * `registerCoreInvariants()` so a single call wires the full v1 set.
 */

import { registerCoreInvariants, registerInvariant } from '@kodax/core';
import type { QualityInvariant } from '@kodax/core';

import { boundedRevise } from './bounded-revise.js';
import { budgetCeiling } from './budget-ceiling.js';
import { independentReview } from './independent-review.js';
import { resolveToolCapability, toolPermission } from './tool-permission.js';

export {
  boundedRevise,
  budgetCeiling,
  independentReview,
  resolveToolCapability,
  toolPermission,
};

/**
 * Coding-package-supplied invariants in registration order.
 */
export const CODING_INVARIANTS: readonly QualityInvariant[] = [
  budgetCeiling,
  toolPermission,
  boundedRevise,
  independentReview,
];

/**
 * Register the @kodax/coding capability-coupled invariants AND the
 * @kodax/core pure-new invariants. Single bootstrap call covers the
 * FEATURE_101 admission v1 closed set + FEATURE_106's external
 * `harnessSelectionTiming`.
 *
 * Order matters: core first (so the closed-set ids appear in
 * registration order before the coding additions), then coding.
 * Tests that need a specific subset should `_resetInvariantRegistry()`
 * and register only what they need.
 */
export function registerCodingInvariants(): void {
  registerCoreInvariants();
  for (const inv of CODING_INVARIANTS) {
    registerInvariant(inv);
  }
}
