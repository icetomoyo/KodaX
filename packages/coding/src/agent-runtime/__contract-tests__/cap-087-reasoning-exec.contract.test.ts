/**
 * Contract test for CAP-087: per-turn reasoning execution state builder
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-087-per-turn-reasoning-execution-state-builder
 *
 * Test obligations:
 * - CAP-REASONING-EXEC-001: effectiveOptions carries repo intel context + policy hints
 * - CAP-REASONING-EXEC-002: systemPromptOverride bypasses buildSystemPrompt
 * - CAP-REASONING-EXEC-003: promptOverlay joins caller + plan overlays in order
 *
 * Risk: MEDIUM (FEATURE_078 v0.7.30 will layer L1-L4 reasoning resolution on top; current shape is the contract FEATURE_078 must preserve)
 *
 * Class: 1
 *
 * Verified location: agent.ts:3066-3120 (buildReasoningExecutionState)
 *
 * Time-ordering constraint: AFTER reasoning plan creation (CAP-052); BEFORE per-turn provider stream.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { buildReasoningExecutionState } from '../per-turn-reasoning.js';

describe('CAP-087: per-turn reasoning execution state builder contract', () => {
  it.todo('CAP-REASONING-EXEC-001: effectiveOptions includes context.repoIntelligenceContext from buildAutoRepoIntelligenceContext and merged context.providerPolicyHints from buildProviderPolicyHintsForDecision');
  it.todo('CAP-REASONING-EXEC-002: when options.context.systemPromptOverride is set, buildSystemPrompt is NOT called and the override is used directly as systemPrompt');
  it.todo('CAP-REASONING-EXEC-003: context.promptOverlay in effectiveOptions is the join of caller overlay + reasoningPlan.promptOverlay in that order (separated by \\n\\n)');
});
