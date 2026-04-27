/**
 * Contract test for CAP-089: task-engine.ts mode dispatcher
 *
 * Test obligations:
 * - CAP-DISPATCH-001: SA mode → runKodaX (now FUNCTION-LEVEL via
 *   FEATURE_100 P3.6t `dispatchManagedTask` DI deps)
 * - CAP-DISPATCH-002: AMA mode → runManagedTaskViaRunner (same)
 * - CAP-DISPATCH-003: default agentMode = 'ama'
 *
 * Risk: HIGH (load-bearing fork point — getting the default wrong
 * silently routes every unannotated task to the SA path, losing AMA
 * orchestration entirely).
 *
 * Class: 1
 *
 * Verified location: task-engine.ts:53 `resolveManagedAgentMode`,
 * task-engine.ts:91+ `dispatchManagedTask` (extracted from inline
 * `executeRunManagedTask` with explicit `ManagedDispatchDeps` so
 * contract tests inject mock SA/AMA executors).
 *
 * Time-ordering constraint: at top of runManagedTask; the result is
 * wrapped by reshapeToUserConversation (CAP-092).
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6t.
 */

import { describe, expect, it, vi } from 'vitest';

import { dispatchManagedTask, resolveManagedAgentMode } from '../../task-engine.js';
import type { KodaXOptions, KodaXResult } from '../../types.js';

function emptyResult(): KodaXResult {
  return {
    success: true,
    lastText: '',
    messages: [],
    sessionId: 'test',
  };
}

describe('CAP-089: task-engine.ts mode dispatcher contract', () => {
  it('CAP-DISPATCH-001: when agentMode is "sa", dispatchManagedTask routes to runSA (and not runAMA)', async () => {
    const runSA = vi.fn().mockResolvedValue(emptyResult());
    const runAMA = vi.fn().mockResolvedValue(emptyResult());
    const buildPlan = vi.fn();
    await dispatchManagedTask(
      { agentMode: 'sa' } as KodaXOptions,
      'do thing',
      { runSA, runAMA, buildPlan },
    );
    expect(runSA).toHaveBeenCalledTimes(1);
    expect(runAMA).not.toHaveBeenCalled();
    expect(buildPlan).not.toHaveBeenCalled();
    // SA branch threads `prompt` and the augmented options (with
    // direct-path overlay) into runSA.
    const [opts, prompt] = runSA.mock.calls[0]!;
    expect(prompt).toBe('do thing');
    expect(opts.agentMode).toBe('sa');
  });

  it('CAP-DISPATCH-002: when agentMode is "ama", dispatchManagedTask routes to runAMA via buildPlan', async () => {
    const runSA = vi.fn();
    const runAMA = vi.fn().mockResolvedValue(emptyResult());
    const buildPlan = vi.fn().mockResolvedValue({
      mode: 'off',
      depth: 'off',
      decision: { primaryTask: 'conversation' },
      amaControllerDecision: undefined,
      promptOverlay: '',
    });
    await dispatchManagedTask(
      { agentMode: 'ama', context: { executionCwd: '/tmp/x' } } as KodaXOptions,
      'plan thing',
      { runSA, runAMA, buildPlan },
    );
    expect(runSA).not.toHaveBeenCalled();
    expect(buildPlan).toHaveBeenCalledTimes(1);
    expect(runAMA).toHaveBeenCalledTimes(1);
    // runAMA receives (options, prompt, undefined, plan) in this order
    const [opts, prompt, _undef, plan] = runAMA.mock.calls[0]!;
    expect(opts.agentMode).toBe('ama');
    expect(prompt).toBe('plan thing');
    expect(plan).toBeDefined();
  });

  it('CAP-DISPATCH-003a: when options.agentMode is undefined, resolveManagedAgentMode defaults to "ama"', () => {
    expect(resolveManagedAgentMode({} as KodaXOptions)).toBe('ama');
  });

  it('CAP-DISPATCH-003b: explicit "sa" agentMode is preserved verbatim', () => {
    expect(resolveManagedAgentMode({ agentMode: 'sa' } as KodaXOptions)).toBe('sa');
  });

  it('CAP-DISPATCH-003c: explicit "ama" agentMode is preserved verbatim', () => {
    expect(resolveManagedAgentMode({ agentMode: 'ama' } as KodaXOptions)).toBe('ama');
  });

  it('CAP-DISPATCH-003d: dispatchManagedTask propagates the default ("ama") when no agentMode is set', async () => {
    const runSA = vi.fn();
    const runAMA = vi.fn().mockResolvedValue(emptyResult());
    const buildPlan = vi.fn().mockResolvedValue({ mode: 'off', depth: 'off', decision: {}, promptOverlay: '' });
    await dispatchManagedTask({} as KodaXOptions, 'p', { runSA, runAMA, buildPlan });
    expect(runSA).not.toHaveBeenCalled();
    expect(runAMA).toHaveBeenCalledTimes(1);
  });
});
