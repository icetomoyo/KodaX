/**
 * FEATURE_106 Slice 1 — `scope-aware-harness-guardrail` unit tests.
 *
 * Covers the short-circuit branches (error / non-mutation tool /
 * sub-threshold / already-injected / Scout already committed) and the
 * rewrite path including the canonical `emit_scout_verdict` payload
 * shape.
 */

import { describe, expect, it } from 'vitest';

import type {
  GuardrailContext,
  RunnerToolCall,
  RunnerToolResult,
  ToolGuardrail,
} from '@kodax/core';
import { createAgent } from '@kodax/core';

import type { KodaXManagedProtocolPayload, ManagedMutationTracker } from '../../types.js';
import {
  buildScopeAwareHarnessHint,
  createScopeAwareHarnessGuardrail,
  SCOPE_AWARE_HARNESS_GUARDRAIL_NAME,
} from './scope-aware-harness-guardrail.js';

function makeTracker(files: Record<string, number>): ManagedMutationTracker {
  return {
    files: new Map(Object.entries(files)),
    totalOps: Object.values(files).reduce((a, b) => a + b, 0),
  };
}

function makePayloadRef(
  payload: KodaXManagedProtocolPayload | undefined = undefined,
): { current: KodaXManagedProtocolPayload | undefined } {
  return { current: payload };
}

const guardrailCtx: GuardrailContext = {
  agent: createAgent({ name: 'scout', instructions: 'classify' }),
};

const okResult: RunnerToolResult = { content: 'wrote 5 lines to a.ts', isError: false };
const errResult: RunnerToolResult = { content: 'permission denied', isError: true };
const writeCall: RunnerToolCall = { id: 'c1', name: 'write', input: {} };

async function invoke(
  guardrail: ToolGuardrail,
  call: RunnerToolCall,
  result: RunnerToolResult,
) {
  if (!guardrail.afterTool) throw new Error('expected afterTool hook');
  return guardrail.afterTool(call, result, guardrailCtx);
}

describe('scope-aware-harness-guardrail short-circuits', () => {
  it('exposes the canonical name', () => {
    expect(SCOPE_AWARE_HARNESS_GUARDRAIL_NAME).toBe('scope-aware-harness');
    const g = createScopeAwareHarnessGuardrail({
      mutationTracker: makeTracker({}),
      payloadRef: makePayloadRef(),
    });
    expect(g.kind).toBe('tool');
    expect(g.name).toBe(SCOPE_AWARE_HARNESS_GUARDRAIL_NAME);
  });

  it('allows error results unchanged', async () => {
    const tracker = makeTracker({ 'a.ts': 50, 'b.ts': 50, 'c.ts': 50 });
    const g = createScopeAwareHarnessGuardrail({
      mutationTracker: tracker,
      payloadRef: makePayloadRef(),
    });
    const verdict = await invoke(g, writeCall, errResult);
    expect(verdict).toEqual({ action: 'allow' });
    expect(tracker.reflectionInjected).toBeUndefined();
  });

  it('allows non-mutation tools unchanged', async () => {
    const tracker = makeTracker({ 'a.ts': 200 }); // would otherwise trigger
    const readCall: RunnerToolCall = { id: 'r', name: 'read', input: {} };
    const g = createScopeAwareHarnessGuardrail({
      mutationTracker: tracker,
      payloadRef: makePayloadRef(),
    });
    const verdict = await invoke(g, readCall, okResult);
    expect(verdict).toEqual({ action: 'allow' });
  });

  it('allows below-threshold mutations (single small file)', async () => {
    const tracker = makeTracker({ 'a.ts': 12 });
    const g = createScopeAwareHarnessGuardrail({
      mutationTracker: tracker,
      payloadRef: makePayloadRef(),
    });
    const verdict = await invoke(g, writeCall, okResult);
    expect(verdict).toEqual({ action: 'allow' });
  });

  it('allows when reflection has already been injected (idempotency)', async () => {
    const tracker = makeTracker({ 'a.ts': 50, 'b.ts': 60, 'c.ts': 80 });
    tracker.reflectionInjected = true;
    const g = createScopeAwareHarnessGuardrail({
      mutationTracker: tracker,
      payloadRef: makePayloadRef(),
    });
    const verdict = await invoke(g, writeCall, okResult);
    expect(verdict).toEqual({ action: 'allow' });
  });

  it('allows when Scout has already committed to H1_EXECUTE_EVAL', async () => {
    const tracker = makeTracker({ 'a.ts': 80, 'b.ts': 90, 'c.ts': 70 });
    const payloadRef = makePayloadRef({
      scout: { confirmedHarness: 'H1_EXECUTE_EVAL', scope: [], requiredEvidence: [] },
    });
    const g = createScopeAwareHarnessGuardrail({ mutationTracker: tracker, payloadRef });
    const verdict = await invoke(g, writeCall, okResult);
    expect(verdict).toEqual({ action: 'allow' });
    expect(tracker.reflectionInjected).toBeUndefined();
  });

  it('still triggers when Scout committed to H0_DIRECT (the calibration target)', async () => {
    const tracker = makeTracker({ 'a.ts': 80, 'b.ts': 90, 'c.ts': 70 });
    const payloadRef = makePayloadRef({
      scout: { confirmedHarness: 'H0_DIRECT', scope: [], requiredEvidence: [] },
    });
    const g = createScopeAwareHarnessGuardrail({ mutationTracker: tracker, payloadRef });
    const verdict = await invoke(g, writeCall, okResult);
    expect(verdict.action).toBe('rewrite');
  });
});

describe('scope-aware-harness-guardrail rewrite path', () => {
  it('rewrites the result with the canonical emit_scout_verdict hint', async () => {
    const tracker = makeTracker({
      'packages/api/src/handlers/auth.ts': 95,
      'packages/api/src/handlers/users.ts': 78,
      'packages/api/src/handlers/sessions.ts': 60,
      'packages/api/src/handlers/tokens.ts': 87,
    });
    const g = createScopeAwareHarnessGuardrail({
      mutationTracker: tracker,
      payloadRef: makePayloadRef(),
    });
    const verdict = await invoke(g, writeCall, okResult);
    expect(verdict.action).toBe('rewrite');
    if (verdict.action !== 'rewrite') return;
    const rewritten = verdict.payload as RunnerToolResult;
    expect(typeof rewritten.content).toBe('string');
    const text = rewritten.content as string;
    expect(text).toContain('wrote 5 lines to a.ts'); // original preserved
    expect(text).toContain('[Scope: 4 files modified, ~320 lines]');
    expect(text).toContain('emit_scout_verdict');
    expect(text).toContain('"H1_EXECUTE_EVAL"');
    expect(text).toContain('"H2_PLAN_EXECUTE_EVAL"');
    // No stale tool name references.
    expect(text).not.toContain('emit_managed_protocol');
    // Idempotency flag set.
    expect(tracker.reflectionInjected).toBe(true);
    // Reason includes scope summary.
    expect(verdict.reason).toContain('4 files');
  });

  it('rewrites only once: a follow-up call after rewrite returns allow', async () => {
    const tracker = makeTracker({ 'a.ts': 80, 'b.ts': 90, 'c.ts': 70 });
    const g = createScopeAwareHarnessGuardrail({
      mutationTracker: tracker,
      payloadRef: makePayloadRef(),
    });
    const first = await invoke(g, writeCall, okResult);
    expect(first.action).toBe('rewrite');
    const second = await invoke(g, writeCall, okResult);
    expect(second).toEqual({ action: 'allow' });
  });
});

describe('buildScopeAwareHarnessHint', () => {
  it('includes the file scope as a JSON array (capped at 4 entries)', () => {
    const tracker = makeTracker({
      'a.ts': 50,
      'b.ts': 60,
      'c.ts': 70,
      'd.ts': 80,
      'e.ts': 90,
      'f.ts': 100,
    });
    const hint = buildScopeAwareHarnessHint(tracker);
    // Only the scope: array sample is capped (a-d, not e/f). The
    // file-list header above still enumerates every modified file —
    // that's the user-visible scope, the JSON array is just an
    // example payload short enough to read.
    expect(hint).toContain('scope: ["a.ts","b.ts","c.ts","d.ts"]');
    // The JSON array specifically excludes e/f.
    const scopeLine = hint.split('\n').find((l) => l.trim().startsWith('scope:'))!;
    expect(scopeLine).not.toContain('e.ts');
    expect(scopeLine).not.toContain('f.ts');
  });

  it('preserves the legacy file-list header verbatim', () => {
    const tracker = makeTracker({ 'a.ts': 50, 'b.ts': 60, 'c.ts': 70 });
    const hint = buildScopeAwareHarnessHint(tracker);
    expect(hint).toContain('[Scope: 3 files modified, ~180 lines]');
    expect(hint).toContain('  - a.ts (~50 lines)');
    expect(hint).toContain('  - b.ts (~60 lines)');
    expect(hint).toContain('  - c.ts (~70 lines)');
  });
});
