/**
 * Contract test for CAP-089: task-engine.ts mode dispatcher
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-089-task-enginets-mode-dispatcher
 *
 * Test obligations:
 * - CAP-DISPATCH-001: SA mode → runKodaX (INTEGRATION-LEVEL — requires
 *   hoisted vi.mock against ./agent.js to intercept the routing call;
 *   deferred until substrate-executor migration extracts the dispatcher
 *   into a standalone module that can be unit-tested with explicit DI.)
 * - CAP-DISPATCH-002: AMA mode → runManagedTaskViaRunner
 *   (INTEGRATION-LEVEL — same constraint as 001.)
 * - CAP-DISPATCH-003: default agentMode = 'ama'
 *   (FUNCTION-LEVEL — fully active here against `resolveManagedAgentMode`.)
 *
 * Risk: HIGH (load-bearing fork point — getting the default wrong
 * silently routes every unannotated task to the SA path, losing
 * AMA orchestration entirely).
 *
 * Class: 1
 *
 * Verified location: task-engine.ts:53 (resolveManagedAgentMode,
 * exported during FEATURE_100 P3.6p for contract activation).
 *
 * Time-ordering constraint: at top of runManagedTask; the result is
 * wrapped by reshapeToUserConversation (CAP-092).
 *
 * STATUS: ACTIVE-PARTIAL since FEATURE_100 P3.6p.
 */

import { describe, expect, it } from 'vitest';

import { resolveManagedAgentMode } from '../../task-engine.js';
import type { KodaXOptions } from '../../types.js';

describe('CAP-089: task-engine.ts mode dispatcher contract', () => {
  it.todo(
    'CAP-DISPATCH-001: when agentMode is "sa", executeRunManagedTask routes to runKodaX — INTEGRATION-LEVEL, deferred until substrate-executor extracts dispatcher into a standalone module.',
  );
  it.todo(
    'CAP-DISPATCH-002: when agentMode is "ama", executeRunManagedTask routes to runManagedTaskViaRunner — INTEGRATION-LEVEL, deferred (same as 001).',
  );

  it('CAP-DISPATCH-003a: when options.agentMode is undefined, resolveManagedAgentMode defaults to "ama"', () => {
    expect(resolveManagedAgentMode({} as KodaXOptions)).toBe('ama');
  });

  it('CAP-DISPATCH-003b: explicit "sa" agentMode is preserved verbatim', () => {
    expect(resolveManagedAgentMode({ agentMode: 'sa' } as KodaXOptions)).toBe('sa');
  });

  it('CAP-DISPATCH-003c: explicit "ama" agentMode is preserved verbatim', () => {
    expect(resolveManagedAgentMode({ agentMode: 'ama' } as KodaXOptions)).toBe('ama');
  });
});
