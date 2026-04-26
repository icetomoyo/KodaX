/**
 * Contract test for CAP-010: tri-state permission gate
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-010-tri-state-permission-gate-plan-mode--accept-edits--extension-toolbefore
 *
 * Test obligations:
 * - CAP-PERMISSION-001: plan-mode block returns CANCELLED message (not generic)
 * - CAP-PERMISSION-002: accept-edits passes through (returns undefined)
 * - CAP-PERMISSION-003: extension `tool:before` hook returning a string yields
 *   the verbatim string as block-with-custom-message
 *
 * Risk: HIGH_RISK_PARITY — `runner-driven.ts:4404-4410` parity-restore evidence:
 * "Legacy agent.ts:810 ran this pre-execute"
 *
 * Verified location: agent-runtime/permission-gate.ts (extracted from
 * agent.ts:565-596 during FEATURE_100 P2)
 *
 * STATUS: ACTIVE since FEATURE_100 P2. The tri-state contract
 * (`undefined` allow / `CANCELLED_TOOL_RESULT_MESSAGE` cancel /
 *  arbitrary string block-with-custom-message) is locked here so any
 * future change is caught.
 */

import { describe, expect, it, vi } from 'vitest';

import { CANCELLED_TOOL_RESULT_MESSAGE } from '../../constants.js';
import { getToolExecutionOverride } from '../permission-gate.js';

describe('CAP-010: tri-state permission gate contract', () => {
  it('CAP-PERMISSION-001: events.beforeToolExecute returning false yields CANCELLED constant (block-as-cancel)', async () => {
    const beforeToolExecute = vi.fn().mockResolvedValue(false);
    const result = await getToolExecutionOverride(
      { beforeToolExecute },
      'edit',
      { path: 'a.ts' },
      'tool_call_1',
    );
    expect(result).toBe(CANCELLED_TOOL_RESULT_MESSAGE);
    expect(beforeToolExecute).toHaveBeenCalledWith('edit', { path: 'a.ts' }, { toolId: 'tool_call_1' });
  });

  it('CAP-PERMISSION-002: events.beforeToolExecute returning true (or undefined) yields undefined (allow)', async () => {
    // `true` allow path
    const allowResult = await getToolExecutionOverride(
      { beforeToolExecute: vi.fn().mockResolvedValue(true) },
      'edit',
      { path: 'a.ts' },
    );
    expect(allowResult).toBeUndefined();

    // No hook wired at all → also allow
    const noHookResult = await getToolExecutionOverride({}, 'edit', { path: 'a.ts' });
    expect(noHookResult).toBeUndefined();
  });

  it('CAP-PERMISSION-003: events.beforeToolExecute returning a string yields that string verbatim (block-with-custom-message)', async () => {
    const customMessage = '[Plan Mode] Would have edited a.ts (1 line). Run without --plan to execute.';
    const beforeToolExecute = vi.fn().mockResolvedValue(customMessage);

    const result = await getToolExecutionOverride(
      { beforeToolExecute },
      'edit',
      { path: 'a.ts' },
    );
    expect(result).toBe(customMessage);
    // Crucially NOT the cancel constant — the loop distinguishes the two by
    // exact string equality.
    expect(result).not.toBe(CANCELLED_TOOL_RESULT_MESSAGE);
  });

  it('CAP-PERMISSION-004: tri-state contract preserved — undefined / CANCELLED constant / arbitrary string are the only return shapes', async () => {
    // This test is a structural assertion: enumerate all three return paths
    // and verify they pass through to the caller distinguishable by type +
    // identity. Future refactors must not flatten the cancel-vs-block
    // distinction (e.g., by mapping false → empty string).
    const cases: Array<{ ret: false | true | string; expected: 'cancel' | 'allow' | 'block' }> = [
      { ret: false, expected: 'cancel' },
      { ret: true, expected: 'allow' },
      { ret: 'custom block reason', expected: 'block' },
    ];

    for (const { ret, expected } of cases) {
      const result = await getToolExecutionOverride(
        { beforeToolExecute: vi.fn().mockResolvedValue(ret) },
        'tool',
        {},
      );
      if (expected === 'cancel') {
        expect(result).toBe(CANCELLED_TOOL_RESULT_MESSAGE);
      } else if (expected === 'allow') {
        expect(result).toBeUndefined();
      } else {
        expect(typeof result).toBe('string');
        expect(result).not.toBe(CANCELLED_TOOL_RESULT_MESSAGE);
      }
    }
  });
});
