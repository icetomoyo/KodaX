/**
 * Contract test for CAP-098: child-executor plan-mode block-check propagation (FEATURE_074)
 *
 * Test obligations:
 * - CAP-CHILD-PLAN-MODE-001: predicate consulted at each child tool call,
 *   block-reason string returned → tool blocked
 * - CAP-CHILD-PLAN-MODE-002: predicate closes over parent state, so
 *   mid-run mode toggle propagates immediately
 * - CAP-CHILD-PLAN-MODE-003: block-reason string surfaces verbatim in
 *   the child's blocked-tool result for auditing
 *
 * Risk: HIGH (security-sensitive — without this, plan-mode toggling
 * mid-run wouldn't propagate to in-flight child tools)
 *
 * Class: 1
 *
 * Verified location: child-executor.ts:81-84 (PlanModeBlockCheck);
 * :503-558 (buildChildEvents — installs the predicate as the
 * `beforeToolExecute` hook).
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6t.
 */

import { describe, expect, it } from 'vitest';

import { buildChildEvents } from '../../child-executor.js';
import type { PlanModeBlockCheck } from '../../child-executor.js';

describe('CAP-098: child-executor plan-mode block-check propagation contract', () => {
  it('CAP-CHILD-PLAN-MODE-001: when planModeBlockCheck returns a non-null string for a tool call, beforeToolExecute returns the block message (tool blocked)', async () => {
    const predicate: PlanModeBlockCheck = (tool) =>
      tool === 'write' ? 'Plan mode blocks write tool' : null;

    const events = buildChildEvents('test-child', undefined, predicate);
    expect(events?.beforeToolExecute).toBeDefined();

    const result = await events!.beforeToolExecute!('write', { path: '/tmp/x' });
    expect(typeof result).toBe('string');
    expect(result as string).toContain('Plan mode blocks write tool');

    // A tool the predicate allows passes through.
    const allowed = await events!.beforeToolExecute!('read', { path: '/tmp/x' });
    expect(allowed).toBe(true);
  });

  it('CAP-CHILD-PLAN-MODE-002: predicate is invoked live on every call, so a parent-state mode toggle propagates immediately to subsequent child tool calls', async () => {
    let mode: 'plan' | 'accept-edits' = 'plan';
    // Closure-captured `mode` simulates the parent REPL's permission ref.
    const predicate: PlanModeBlockCheck = (tool) =>
      mode === 'plan' && tool === 'write' ? 'Plan mode active' : null;

    const events = buildChildEvents('toggle-child', undefined, predicate);

    const beforeToggle = await events!.beforeToolExecute!('write', { path: '/tmp/a' });
    expect(typeof beforeToggle).toBe('string');
    expect(beforeToggle as string).toContain('Plan mode active');

    // Parent flips mode mid-run.
    mode = 'accept-edits';

    const afterToggle = await events!.beforeToolExecute!('write', { path: '/tmp/b' });
    expect(afterToggle).toBe(true);
  });

  it('CAP-CHILD-PLAN-MODE-003: predicate-returned block reason surfaces verbatim (with the child-context suffix appended) in the beforeToolExecute return value', async () => {
    const exactReason = 'Custom audit reason 0xDEADBEEF';
    const predicate: PlanModeBlockCheck = () => exactReason;

    const events = buildChildEvents('audit-child', undefined, predicate);
    const result = await events!.beforeToolExecute!('write', { path: '/tmp/x' });

    expect(typeof result).toBe('string');
    // The child layer appends its own context line ("You are a child
    // agent inheriting plan-mode constraints…") but the original
    // reason MUST be present verbatim for the caller's auditing
    // pipeline to recognise it.
    expect(result as string).toContain(exactReason);
  });

  it('CAP-CHILD-PLAN-MODE-EXTRA: CHILD_BLOCKED_TOOLS gate runs BEFORE planModeBlockCheck — recursion-prevention contract', async () => {
    // dispatch_child_task is in CHILD_BLOCKED_TOOLS regardless of plan
    // mode; the predicate should NEVER be consulted for it.
    const predicate: PlanModeBlockCheck = () => {
      throw new Error('predicate must not be invoked for blocked tools');
    };
    const events = buildChildEvents('block-test', undefined, predicate);
    const result = await events!.beforeToolExecute!('dispatch_child_task', {});
    expect(typeof result).toBe('string');
    expect(result as string).toContain('Not available in child agent context');
  });
});
