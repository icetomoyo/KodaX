/**
 * Contract test for CAP-016: mutation scope reflection
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-016-mutation-scope-reflection
 *
 * Test obligations:
 * - CAP-MUTATION-REFLECT-001: significant mutation triggers reflection
 *   append. Decomposed here into the three function-level building blocks
 *   that the substrate executor will compose:
 *
 *   • `isMutationTool(name)` — predicate for mutation tool names.
 *   • `isMutationScopeSignificant(tracker)` — file-count OR line-count
 *     threshold predicate.
 *   • `buildMutationScopeReflection(tracker)` — text builder. v0.7.31.2
 *     rewrote the body to be SA-self-review oriented (header line +
 *     senior-engineer rhetorical line + 3 self-review action lines)
 *     after the legacy "six canonical lines" with `emit_managed_protocol`
 *     references was found to induce hallucinated tool calls in SA
 *     mode (which has no AMA escalation tools on its surface).
 *
 * - CAP-MUTATION-REFLECT-002: read-only tool name → `isMutationTool`
 *   returns false (so the call site short-circuits before invoking
 *   the builder).
 *
 * - CAP-MUTATION-REFLECT-003 / -004 (declaration on/off behavior):
 *   `it.todo` with deferral note — the `middleware.mutationScopeReflection`
 *   flag lives on Agent declaration, which is P3 territory. P2 owns
 *   the building blocks; P3 owns the gate.
 *
 * Risk: LOW
 *
 * Class: 3 — declarable opt-in middleware (per
 * `AgentDeclaration.middleware.mutationScopeReflection: true`).
 *
 * Default for: `defaultCodingAgent`. NOT for AMA agents — Generator's
 * mutation tracking is handled by Evaluator's verdict pass instead.
 *
 * Verified location: agent-runtime/middleware/mutation-reflection.ts
 * (extracted from agent.ts:781-809 — pre-FEATURE_100 baseline — during
 * FEATURE_100 P2)
 *
 * STATUS: ACTIVE since FEATURE_100 P2 for the three building-block
 * predicates. Declaration-gate tests stay `it.todo`.
 */

import { describe, expect, it } from 'vitest';

import {
  buildMutationScopeReflection,
  isMutationScopeSignificant,
  isMutationTool,
} from '../middleware/mutation-reflection.js';

type Tracker = { files: Map<string, number>; totalOps: number; reflectionInjected?: boolean };

function makeTracker(entries: Array<[string, number]>, totalOps = 0): Tracker {
  return { files: new Map(entries), totalOps };
}

describe('CAP-016: mutation scope reflection contract', () => {
  it('CAP-MUTATION-REFLECT-001a: isMutationTool recognises the canonical mutation tool names (case-insensitive)', () => {
    for (const name of ['edit', 'write', 'multi_edit', 'apply_patch', 'delete', 'remove', 'rename']) {
      expect(isMutationTool(name)).toBe(true);
      expect(isMutationTool(name.toUpperCase())).toBe(true);
    }
  });

  it('CAP-MUTATION-REFLECT-002: isMutationTool returns false for read-only / non-mutation tools', () => {
    for (const name of ['read', 'glob', 'grep', 'bash', 'module_context', 'symbol_context']) {
      expect(isMutationTool(name)).toBe(false);
    }
  });

  it('CAP-MUTATION-REFLECT-001b: isMutationScopeSignificant returns true when files.size ≥ 3 (file-count threshold)', () => {
    expect(isMutationScopeSignificant(makeTracker([['a.ts', 1]]))).toBe(false);
    expect(isMutationScopeSignificant(makeTracker([['a.ts', 1], ['b.ts', 1]]))).toBe(false);
    expect(isMutationScopeSignificant(makeTracker([['a.ts', 1], ['b.ts', 1], ['c.ts', 1]]))).toBe(true);
  });

  it('CAP-MUTATION-REFLECT-001c: isMutationScopeSignificant returns true when total lines ≥ 100 (line-count threshold)', () => {
    expect(isMutationScopeSignificant(makeTracker([['a.ts', 99]]))).toBe(false);
    expect(isMutationScopeSignificant(makeTracker([['a.ts', 100]]))).toBe(true);
    expect(isMutationScopeSignificant(makeTracker([['a.ts', 50], ['b.ts', 50]]))).toBe(true);
  });

  it('CAP-MUTATION-REFLECT-001d: isMutationScopeSignificant short-circuits — file-count OR line-count is sufficient on its own', () => {
    // 3 files but each tiny → still significant via file-count branch
    expect(isMutationScopeSignificant(makeTracker([['a.ts', 1], ['b.ts', 1], ['c.ts', 1]]))).toBe(true);
    // 2 files but huge → still significant via line-count branch
    expect(isMutationScopeSignificant(makeTracker([['a.ts', 60], ['b.ts', 60]]))).toBe(true);
  });

  it('CAP-MUTATION-REFLECT-001e: buildMutationScopeReflection produces the SA-self-review text including file count, total lines, file list, and the senior-engineer rhetorical prompt', () => {
    const text = buildMutationScopeReflection(
      makeTracker([['src/foo.ts', 40], ['src/bar.ts', 80]]),
    );

    expect(text).toContain('[Scope: 2 files modified, ~120 lines]');
    expect(text).toContain('  - src/foo.ts (~40 lines)');
    expect(text).toContain('  - src/bar.ts (~80 lines)');
    expect(text).toContain('A senior engineer would pause here.');
    expect(text).toContain('SA mode has no Evaluator');
    // v0.7.31.2 — the text MUST NOT reference the AMA escalation tool
    // names (`emit_managed_protocol`, `emit_scout_verdict`,
    // `H1_EXECUTE_EVAL`, `H2_PLAN_EXECUTE_EVAL`). SA mode has no mid-run
    // escalation path, and the legacy tool names produced hallucinated
    // tool calls when the LLM took the prompt at face value. Equivalent
    // AMA prompting lives in `scope-aware-harness-guardrail.ts`.
    expect(text).not.toContain('emit_managed_protocol');
    expect(text).not.toContain('emit_scout_verdict');
    expect(text).not.toContain('H1_EXECUTE_EVAL');
    expect(text).not.toContain('H2_PLAN_EXECUTE_EVAL');
  });

  it('CAP-MUTATION-REFLECT-001f: buildMutationScopeReflection starts with a leading blank line so the appended text separates from the preceding tool-result content', () => {
    const text = buildMutationScopeReflection(makeTracker([['a.ts', 1]]));
    expect(text.startsWith('\n')).toBe(true);
  });

  it.todo('CAP-MUTATION-REFLECT-003: agent declaration with middleware.mutationScopeReflection: false → no reflection appended even on significant mutation (gate lives at call site / P3 substrate executor)');
  it.todo('CAP-MUTATION-REFLECT-004: AMA Generator agent (no mutationScopeReflection middleware) does not append reflection — Evaluator owns mutation feedback (Agent declaration territory, P3)');
});
