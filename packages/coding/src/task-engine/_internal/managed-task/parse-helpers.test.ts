/**
 * C1 parity tests — `attemptProtocolTextFallback` + `getEmitToolNameForRole`.
 *
 * Scenario coverage mirrors the 4 v0.7.22 call sites that consumed a
 * `?? parseManagedTask*Directive(text)` fallback when the LLM forgot to
 * call the emit tool but wrote a well-formed `kodax-task-*` block:
 *   - Scout  → emit_scout_verdict  (block: kodax-task-scout)
 *   - Planner → emit_contract       (block: kodax-task-contract)
 *   - Generator → emit_handoff      (block: kodax-task-handoff)
 *   - Evaluator → emit_verdict      (block: kodax-task-verdict)
 */

import { describe, expect, it } from 'vitest';
import {
  attemptProtocolTextFallback,
  findLastFencedBlock,
  getEmitToolNameForRole,
} from './parse-helpers.js';

describe('getEmitToolNameForRole', () => {
  it('maps each managed role to the registered emit tool name', () => {
    expect(getEmitToolNameForRole('scout')).toBe('emit_scout_verdict');
    expect(getEmitToolNameForRole('planner')).toBe('emit_contract');
    expect(getEmitToolNameForRole('generator')).toBe('emit_handoff');
    expect(getEmitToolNameForRole('evaluator')).toBe('emit_verdict');
  });
});

describe('attemptProtocolTextFallback — scout', () => {
  it('returns synthesized metadata when text carries a kodax-task-scout block with valid JSON', () => {
    const text = [
      'Here is what I found in scope.',
      '',
      '```kodax-task-scout',
      JSON.stringify({
        summary: 'scope looks small',
        scope: ['src/a.ts'],
        confirmed_harness: 'H1_EXECUTE_EVAL',
      }),
      '```',
    ].join('\n');

    const meta = attemptProtocolTextFallback('scout', text);
    expect(meta).toBeDefined();
    expect(meta!.role).toBe('scout');
    expect(meta!.payload.scout?.confirmedHarness).toBe('H1_EXECUTE_EVAL');
    expect(meta!.payload.scout?.scope).toEqual(['src/a.ts']);
    // H1 → Generator handoff, not terminal
    expect(meta!.handoffTarget).toBe('kodax/role/generator');
    expect(meta!.isTerminal).toBe(false);
  });

  it('treats H0_DIRECT as terminal with no handoff target', () => {
    const text = [
      '```kodax-task-scout',
      JSON.stringify({ confirmed_harness: 'H0_DIRECT', summary: 'trivial' }),
      '```',
    ].join('\n');
    const meta = attemptProtocolTextFallback('scout', text);
    expect(meta).toBeDefined();
    expect(meta!.isTerminal).toBe(true);
    expect(meta!.handoffTarget).toBeUndefined();
  });

  it('returns undefined when no kodax-task-scout block exists in text', () => {
    expect(attemptProtocolTextFallback('scout', 'just some text no block')).toBeUndefined();
  });

  it('returns undefined when block body is invalid JSON', () => {
    const text = '```kodax-task-scout\nnot-json\n```';
    expect(attemptProtocolTextFallback('scout', text)).toBeUndefined();
  });
});

describe('attemptProtocolTextFallback — planner (contract)', () => {
  it('parses a well-formed kodax-task-contract block', () => {
    const text = [
      '```kodax-task-contract',
      JSON.stringify({
        summary: 'Implement X',
        success_criteria: ['pass tests', 'user can call /foo'],
        required_evidence: ['unit tests green'],
        constraints: ['do not touch auth'],
      }),
      '```',
    ].join('\n');
    const meta = attemptProtocolTextFallback('planner', text);
    expect(meta).toBeDefined();
    expect(meta!.role).toBe('planner');
    expect(meta!.payload.contract?.successCriteria).toEqual(['pass tests', 'user can call /foo']);
    // planner always hands off to generator
    expect(meta!.handoffTarget).toBe('kodax/role/generator');
  });

  it('returns undefined when contract body has no substantive fields', () => {
    const text = '```kodax-task-contract\n{}\n```';
    expect(attemptProtocolTextFallback('planner', text)).toBeUndefined();
  });
});

describe('attemptProtocolTextFallback — generator (handoff)', () => {
  it('parses a well-formed kodax-task-handoff block', () => {
    const text = [
      '```kodax-task-handoff',
      JSON.stringify({
        status: 'ready',
        summary: 'all edits applied',
        evidence: ['tests green'],
        followup: [],
      }),
      '```',
    ].join('\n');
    const meta = attemptProtocolTextFallback('generator', text);
    expect(meta).toBeDefined();
    expect(meta!.payload.handoff?.status).toBe('ready');
    expect(meta!.handoffTarget).toBe('kodax/role/evaluator');
  });
});

describe('attemptProtocolTextFallback — evaluator (verdict)', () => {
  it('parses a kodax-task-verdict block with accept status as terminal', () => {
    const text = [
      'Summary for the user here.',
      '',
      '```kodax-task-verdict',
      JSON.stringify({
        status: 'accept',
        reason: 'all criteria met',
        user_answer: 'Task complete.',
      }),
      '```',
    ].join('\n');
    const meta = attemptProtocolTextFallback('evaluator', text);
    expect(meta).toBeDefined();
    expect(meta!.payload.verdict?.status).toBe('accept');
    expect(meta!.payload.verdict?.userAnswer).toBe('Task complete.');
    expect(meta!.isTerminal).toBe(true);
  });

  it('parses a revise verdict and routes back to generator by default', () => {
    const text = [
      '```kodax-task-verdict',
      JSON.stringify({ status: 'revise', reason: 'test coverage gap' }),
      '```',
    ].join('\n');
    const meta = attemptProtocolTextFallback('evaluator', text);
    expect(meta).toBeDefined();
    expect(meta!.payload.verdict?.status).toBe('revise');
    expect(meta!.handoffTarget).toBe('kodax/role/generator');
    expect(meta!.isTerminal).toBe(false);
  });

  it('routes revise + next_harness=H2_PLAN_EXECUTE_EVAL back to planner', () => {
    const text = [
      '```kodax-task-verdict',
      JSON.stringify({ status: 'revise', next_harness: 'H2_PLAN_EXECUTE_EVAL' }),
      '```',
    ].join('\n');
    const meta = attemptProtocolTextFallback('evaluator', text);
    expect(meta!.handoffTarget).toBe('kodax/role/planner');
  });

  it('propagates assistant text preceding the block into userFacingText', () => {
    const text = [
      'Here is the final answer for the user.',
      '',
      '```kodax-task-verdict',
      JSON.stringify({ status: 'accept' }),
      '```',
    ].join('\n');
    const meta = attemptProtocolTextFallback('evaluator', text);
    expect(meta!.payload.verdict?.userFacingText).toContain('Here is the final answer');
  });
});

describe('attemptProtocolTextFallback — negative edges', () => {
  it('prefers the LAST fenced block when multiple exist (v22 parity)', () => {
    const text = [
      '```kodax-task-scout',
      JSON.stringify({ confirmed_harness: 'H0_DIRECT', summary: 'first' }),
      '```',
      '(revised)',
      '```kodax-task-scout',
      JSON.stringify({ confirmed_harness: 'H1_EXECUTE_EVAL', summary: 'second' }),
      '```',
    ].join('\n');
    const meta = attemptProtocolTextFallback('scout', text);
    expect(meta!.payload.scout?.confirmedHarness).toBe('H1_EXECUTE_EVAL');
    expect(meta!.payload.scout?.summary).toBe('second');
  });

  it('returns undefined for an unknown role', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(attemptProtocolTextFallback('direct' as any, 'x')).toBeUndefined();
  });
});

describe('findLastFencedBlock — FEATURE_060 Track 1: tail-only scan for large texts', () => {
  it('matches a fenced block at the very end of a large text without scanning the leading portion', () => {
    // Build a 200KB filler that contains lookalike syntax — the scanner
    // must still find ONLY the trailing legitimate block.
    const filler = '`'.repeat(200_000);
    const tail = '\n```kodax-task-scout\n{"summary":"tail block"}\n```\n';
    const text = filler + tail;

    const block = findLastFencedBlock(text, 'kodax-task-scout');
    expect(block).toBeDefined();
    expect(block!.body).toBe('{"summary":"tail block"}');
    // index points into the original full-text coordinate space.
    expect(block!.index).toBeGreaterThanOrEqual(filler.length);
    expect(text.slice(0, block!.index)).toMatch(/`{1,}/);
  });

  it('returns undefined when no fenced block exists in the tail window of a huge text', () => {
    // 200KB of unrelated text, then a block well before the tail window —
    // the tail-only scan should not see it.
    const earlyBlock = '```kodax-task-scout\n{"summary":"early"}\n```\n';
    const tailFiller = 'x'.repeat(200_000);
    const text = earlyBlock + tailFiller;

    const block = findLastFencedBlock(text, 'kodax-task-scout');
    expect(block).toBeUndefined();
  });

  it('full-text scan path: small text below the threshold scans the entire payload', () => {
    // Threshold is 128KB; this test stays well under to exercise the
    // non-tail path explicitly.
    const text = [
      'lots of preamble',
      '',
      '```kodax-task-scout',
      '{"summary":"normal"}',
      '```',
      '',
      'trailing content',
    ].join('\n');

    const block = findLastFencedBlock(text, 'kodax-task-scout');
    expect(block).toBeDefined();
    expect(block!.body).toBe('{"summary":"normal"}');
  });

  it('with a fenced block straddling the tail boundary, the tail scan still finds it (block is in the tail window)', () => {
    // Build a 130KB prefix + a small tail with the block — the entire
    // block is inside the tail window so it gets matched.
    const prefix = 'a'.repeat(130_000);
    const tail = '```kodax-task-handoff\n{"role":"handoff"}\n```\n';
    const text = prefix + '\n' + tail;

    const block = findLastFencedBlock(text, 'kodax-task-handoff');
    expect(block).toBeDefined();
    expect(block!.body).toBe('{"role":"handoff"}');
    // index in full-text coordinates.
    expect(text.slice(block!.index, block!.index + 4)).toBe('```k');
  });
});
