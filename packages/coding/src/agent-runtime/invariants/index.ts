

import { registerCoreInvariants, registerInvariant } from '@kodax-ai/agent';
import type { QualityInvariant } from '@kodax-ai/agent';

import { boundedRevise } from './bounded-revise.js';
import { budgetCeiling } from './budget-ceiling.js';
import { harnessSelectionTiming } from './harness-selection-timing.js';
import { planBeforeMutate } from './plan-before-mutate.js';
import { resolveToolCapability, toolPermission } from './tool-permission.js';

export {
  boundedRevise,
  budgetCeiling,
  harnessSelectionTiming,
  planBeforeMutate,
  resolveToolCapability,
  toolPermission,
};

/**
 * Coding-package-supplied invariants in registration order.
 * v0.7.35.1 FEATURE_142 (A-R2): added `harnessSelectionTiming` (moved
 * from @kodax-ai/agent's pure-invariant set).
 *
 * v0.7.36 FEATURE_114: added `planBeforeMutate` — V2 plan-first
 * structural observation. Registers alongside `harnessSelectionTiming`
 * (not as a replacement). FEATURE_193 (v0.7.43) retired V1 — the
 * `harnessSelectionTiming` predicate is now a permanent no-op (it
 * always admits, since the V2 Worker single-loop is the new V2
 * harness-discipline anchor) but stays registered so existing
 * admission manifests + tests keep working.
 */
export const CODING_INVARIANTS: readonly QualityInvariant[] = [
  budgetCeiling,
  toolPermission,
  boundedRevise,
  harnessSelectionTiming,
  planBeforeMutate,
];

/**
 * Register the @kodax-ai/coding capability-coupled + coding-AMA-specific
 * invariants AND the @kodax-ai/agent pure-new invariants. Single bootstrap
 * call covers the FEATURE_101 admission v1 closed set + FEATURE_106's
 * external `harnessSelectionTiming`.
 *
 * Order matters: agent first (so the closed-set ids appear in
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
