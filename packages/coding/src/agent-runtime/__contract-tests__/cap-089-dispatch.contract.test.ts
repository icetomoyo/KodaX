/**
 * Contract test for CAP-089: task-engine.ts mode dispatcher
 *
 * Test obligations:
 * - CAP-DISPATCH-001: retired "sa" input runs the AMA Worker unchanged
 * - CAP-DISPATCH-002: AMA mode → runManagedTaskViaRunner via buildPlan
 * - CAP-DISPATCH-003: retired labels never reach the Worker: 'sa' runs unlabeled, 'amaw' as 'ama'
 *
 * Risk: HIGH (load-bearing entry point — every managed task passes here).
 *
 * Class: 1
 *
 * Verified location: task-engine.ts `dispatchManagedTask` (explicit `ManagedDispatchDeps` so contract tests
 * inject a mock AMA executor).
 *
 * Time-ordering constraint: at top of runManagedTask; the result is
 * wrapped by reshapeToUserConversation (CAP-092).
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6t. FEATURE_310 removed the SA branch.
 */

import { describe, expect, it, vi } from 'vitest';

import { dispatchManagedTask } from '../../task-engine.js';
import type { KodaXOptions, KodaXResult } from '../../types.js';

function emptyResult(): KodaXResult {
  return {
    success: true,
    lastText: '',
    messages: [],
    sessionId: 'test',
  };
}

function amaDeps() {
  const runAMA = vi.fn().mockResolvedValue(emptyResult());
  const buildPlan = vi.fn().mockResolvedValue({ effort: 'none', decision: {}, promptOverlay: '' });
  return { runAMA, buildPlan };
}

describe('CAP-089: task-engine.ts mode dispatcher contract', () => {
  it('CAP-DISPATCH-001: retired "sa" input runs the AMA Worker without overlay or tool exclusions', async () => {
    const deps = amaDeps();
    await dispatchManagedTask(
      { agentMode: 'sa', context: { promptOverlay: 'caller-only' } } as KodaXOptions,
      'review the diff for issues',
      deps,
    );
    expect(deps.buildPlan).toHaveBeenCalledTimes(1);
    expect(deps.runAMA).toHaveBeenCalledTimes(1);
    const [opts, prompt] = deps.runAMA.mock.calls[0]!;
    expect(prompt).toBe('review the diff for issues');
    expect(opts.context?.promptOverlay).toBe('caller-only');
    expect(opts.context?.excludeTools).toBeUndefined();
    // The retired label must not reach the Worker, where it would surface in effectiveConfig.
    expect('agentMode' in opts).toBe(false);
  });

  it('CAP-DISPATCH-002: when agentMode is "ama", dispatchManagedTask routes to runAMA via buildPlan', async () => {
    const runAMA = vi.fn().mockResolvedValue(emptyResult());
    const buildPlan = vi.fn().mockResolvedValue({
      effort: 'none',
      decision: { primaryTask: 'conversation' },
      promptOverlay: '',
    });
    await dispatchManagedTask(
      { agentMode: 'ama', context: { executionCwd: '/tmp/x' } } as KodaXOptions,
      'plan thing',
      { runAMA, buildPlan },
    );
    expect(buildPlan).toHaveBeenCalledTimes(1);
    expect(runAMA).toHaveBeenCalledTimes(1);
    // runAMA receives (options, prompt, undefined, plan) in this order
    const [opts, prompt, _undef, plan] = runAMA.mock.calls[0]!;
    expect(opts.agentMode).toBe('ama');
    expect(prompt).toBe('plan thing');
    expect(plan).toBeDefined();
  });

  it.each([['ama', 'ama'], ['amaw', 'ama'], ['sa', undefined]] as const)(
    'CAP-DISPATCH-003b: "%s" input reaches the Worker as %s',
    async (mode, expected) => {
      const deps = amaDeps();
      await dispatchManagedTask({ agentMode: mode } as KodaXOptions, 'p', deps);
      expect(deps.runAMA.mock.calls[0]![0].agentMode).toBe(expected);
    },
  );

  it('CAP-DISPATCH-003d: an unlabeled call runs the Worker and stays unlabeled', async () => {
    const deps = amaDeps();
    const options = {} as KodaXOptions;
    await dispatchManagedTask(options, 'p', deps);
    expect(deps.runAMA).toHaveBeenCalledTimes(1);
    expect(deps.runAMA.mock.calls[0]![0]).toBe(options);
  });

  it.each([
    ['Review three independent dimensions.', undefined],
    ['Use the named scoped-review Workflow.', 'explicit'],
  ] as const)(
    'CAP-DISPATCH-004: attributes natural-language Workflow intent for %s',
    async (prompt, expectedIntent) => {
      const deps = amaDeps();

      await dispatchManagedTask({ agentMode: 'ama' } as KodaXOptions, prompt, deps);

      const [planOptions] = deps.buildPlan.mock.calls[0]!;
      const [runOptions] = deps.runAMA.mock.calls[0]!;
      expect(planOptions.context?.workflowIntent).toBe(expectedIntent);
      expect(runOptions.context?.workflowIntent).toBe(expectedIntent);
    },
  );
});
