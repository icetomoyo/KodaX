/**
 * FEATURE_079 — Task Engine Phase 1 Pure Extraction (Slice 8, partial)
 *
 * Managed-worker agent-name resolver. Simple pure mapping from role → display
 * agent name used in role prompts.
 *
 * Not moved in this slice (deferred):
 * - `createRolePrompt` (~483 lines) — depends on the task-engine-local
 *   `ManagedRolePromptContext` interface and several other local helpers
 *   (`buildRuntimeExecutionGuide`, tool-policy constants). This is the largest
 *   remaining extraction candidate; scheduled for a dedicated follow-up so the
 *   move can carry its support types together.
 * - `buildManagedWorkerToolPolicy` — depends on large tool-name arrays and
 *   local `ScoutMutationIntent` type; moves alongside tool-policy constants
 *   in a follow-up slice.
 */

import type { KodaXTaskRole } from '../../../types.js';

// Note: `workerId` is accepted but not used today — kept in the signature because
// call sites pass it and future role-specific naming may distinguish workers.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function buildManagedWorkerAgent(role: KodaXTaskRole, workerId?: string): string {
  switch (role) {
    case 'scout':
      return 'ScoutAgent';
    case 'planner':
      return 'PlanningAgent';
    case 'generator':
      return 'ExecutionAgent';
    case 'evaluator':
      return 'EvaluationAgent';
    case 'direct':
    default:
      return 'DirectAgent';
  }
}
