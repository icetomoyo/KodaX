import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { KodaXEvents, KodaXManagedTaskStatus, KodaXTaskRole } from '../../../types.js';
import type { ManagedTaskBudgetController } from './budget.js';
import { buildObserverBridge, NULL_OBSERVER } from './observer-bridge.js';

/**
 * Scaffolding to invoke `buildObserverBridge` for the surface-contract
 * assertions below. The full event-shape coverage lives in
 * `runner-driven.test.ts`; this file pins status and budget delivery,
 * including the optional `checkpointWriter`.
 */
function makeBridgeHarness() {
  const statuses: KodaXManagedTaskStatus[] = [];
  const events: KodaXEvents = {
    onManagedTaskStatus: (s) => {
      statuses.push(s);
    },
  };
  const budget: ManagedTaskBudgetController = {
    totalBudget: 100,
    spentBudget: 0,
    currentHarness: 'H2_PLAN_EXECUTE_EVAL',
  };
  const checkpointWriter = vi.fn<(role: KodaXTaskRole) => void>();
  const bridge = buildObserverBridge(
    events,
    { current: 'H2_PLAN_EXECUTE_EVAL' },
    { emitted: [] },
    budget,
    { current: 3 },
    { current: 6 },
    { current: false },
    { items: [] },
    { current: 'session-abc' },
    checkpointWriter,
  );
  return { bridge, statuses, checkpointWriter };
}

describe('observer-bridge — stallSidecarFired (FEATURE_187 Phase C opt-in log)', () => {
  it('emits a persisted `phase: "worker"` summary note with isStuck + model + elapsed + trace', () => {
    const { bridge, statuses, checkpointWriter } = makeBridgeHarness();

    bridge.stallSidecarFired({
      isStuck: true,
      providerName: 'zhipu-coding',
      model: 'glm-5.1',
      source: 'inherit-main',
      elapsedMs: 1842,
      trace: 'sidecar_ok',
    });

    expect(statuses).toHaveLength(1);
    const ev = statuses[0]!;
    expect(ev.phase).toBe('worker');
    expect(ev.persistToHistory).toBe(true);
    expect(ev.note).toContain('[Stall Sidecar]');
    expect(ev.note).toContain('isStuck=true');
    expect(ev.note).toContain('zhipu-coding/glm-5.1');
    expect(ev.note).toContain('(inherit)');
    expect(ev.note).toContain('1842ms');
    expect(ev.note).toContain('sidecar_ok');
    // Stall-log emission is observer-layer only — no recorder mutation,
    // no checkpoint write (orchestrator owns L1+L2 lifecycle).
    expect(checkpointWriter).not.toHaveBeenCalled();
  });

  it('labels env-override stall sidecar as `(env)` for cross-family awareness', () => {
    const { bridge, statuses } = makeBridgeHarness();

    bridge.stallSidecarFired({
      isStuck: true,
      providerName: 'ark-coding',
      model: 'deepseek-v4-flash',
      source: 'explicit-env',
      elapsedMs: 1500,
      trace: 'sidecar_ok',
    });

    expect(statuses[0]!.note).toContain('(env)');
  });

  it('renders undefined model as `(default)` for the inherit-default-model case', () => {
    const { bridge, statuses } = makeBridgeHarness();

    bridge.stallSidecarFired({
      isStuck: true,
      providerName: 'anthropic',
      model: undefined,
      source: 'inherit-main',
      elapsedMs: 800,
      trace: 'sidecar_ok',
    });

    const note = statuses[0]!.note ?? '';
    expect(note).toContain('anthropic/(default)');
    expect(note).not.toContain('undefined');
  });

  it('NULL_OBSERVER stallSidecarFired is a no-op so chain-only paths do not throw', () => {
    expect(typeof NULL_OBSERVER.stallSidecarFired).toBe('function');
    expect(() =>
      NULL_OBSERVER.stallSidecarFired({
        isStuck: false,
        providerName: 'anthropic',
        model: 'claude-sonnet-4-6',
        source: 'inherit-main',
        elapsedMs: 100,
        trace: 'sidecar_ok',
      }),
    ).not.toThrow();
  });
});
