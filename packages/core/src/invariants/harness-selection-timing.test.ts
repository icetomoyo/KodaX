/**
 * FEATURE_106 — `harnessSelectionTiming` invariant unit tests.
 *
 * Observe-only, warn-severity. Triggers when:
 *   - event.kind === 'mutation_recorded'
 *   - event.fileCount > 1
 *   - ctx.recorder.scout.payload.scout.confirmedHarness is missing
 *
 * Otherwise admits (no signal).
 */

import { describe, expect, it } from 'vitest';

import { createAgent } from '../agent.js';
import type { ObserveCtx, ReadonlyRecorder } from '../admission.js';
import { harnessSelectionTiming } from './harness-selection-timing.js';

const manifest = createAgent({ name: 'scout', instructions: 'classify' });

function obsCtx(recorder: ReadonlyRecorder = {}): ObserveCtx {
  return {
    manifest,
    mutationTracker: { files: new Set(), totalOps: 0 },
    recorder,
  };
}

describe('harnessSelectionTiming.observe', () => {
  it('passes non-mutation events through', () => {
    expect(
      harnessSelectionTiming.observe!(
        { kind: 'tool_call', toolName: 'read' },
        obsCtx(),
      ).ok,
    ).toBe(true);
  });

  it('passes single-file mutations regardless of confirmedHarness', () => {
    expect(
      harnessSelectionTiming.observe!(
        { kind: 'mutation_recorded', file: 'a.ts', fileCount: 1 },
        obsCtx(),
      ).ok,
    ).toBe(true);
  });

  it('warns on multi-file mutation when confirmedHarness is missing', () => {
    const result = harnessSelectionTiming.observe!(
      { kind: 'mutation_recorded', file: 'b.ts', fileCount: 4 },
      obsCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe('warn');
      expect(result.reason).toContain('fileCount=4');
      expect(result.reason).toContain('without a Scout-emitted confirmedHarness');
    }
  });

  it('warns when scout block exists but confirmedHarness is empty string', () => {
    const recorder: ReadonlyRecorder = {
      scout: { payload: { scout: { confirmedHarness: '' } } },
    };
    const result = harnessSelectionTiming.observe!(
      { kind: 'mutation_recorded', file: 'a.ts', fileCount: 2 },
      obsCtx(recorder),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.severity).toBe('warn');
  });

  it('admits when confirmedHarness is set', () => {
    const recorder: ReadonlyRecorder = {
      scout: { payload: { scout: { confirmedHarness: 'H1_EXECUTE_EVAL' } } },
    };
    expect(
      harnessSelectionTiming.observe!(
        { kind: 'mutation_recorded', file: 'a.ts', fileCount: 3 },
        obsCtx(recorder),
      ).ok,
    ).toBe(true);
  });

  it('admits H2 verdict on multi-file mutation', () => {
    const recorder: ReadonlyRecorder = {
      scout: { payload: { scout: { confirmedHarness: 'H2_PLAN_EXECUTE_EVAL' } } },
    };
    expect(
      harnessSelectionTiming.observe!(
        { kind: 'mutation_recorded', file: 'a.ts', fileCount: 7 },
        obsCtx(recorder),
      ).ok,
    ).toBe(true);
  });
});
