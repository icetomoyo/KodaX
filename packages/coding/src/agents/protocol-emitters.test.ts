/**
 * Protocol emitter tool tests — FEATURE_084 Shard 2 (v0.7.26).
 *
 * Verifies that each emit tool:
 *   1. Has the expected tool name + required input fields
 *   2. Normalizes valid payloads via `coerceManagedProtocolToolPayload`
 *   3. Returns the normalized payload under `metadata.payload`
 *   4. Surfaces `isError: true` when the payload cannot be normalized
 *   5. Produces payloads IDENTICAL to what the legacy fenced-block parser
 *      would emit for the same JSON (parity contract)
 */

import { describe, expect, it } from 'vitest';
import type { ProtocolEmitterMetadata } from './protocol-emitters.js';
import {
  EMIT_CONTRACT_TOOL_NAME,
  EMIT_HANDOFF_TOOL_NAME,
  EMIT_SCOUT_VERDICT_TOOL_NAME,
  EMIT_VERDICT_TOOL_NAME,
  PROTOCOL_EMITTER_TOOLS,
  emitContract,
  emitHandoff,
  emitScoutVerdict,
  emitVerdict,
} from './protocol-emitters.js';
import { coerceManagedProtocolToolPayload } from '../managed-protocol.js';

function runExecute(tool: typeof emitScoutVerdict, input: Record<string, unknown>) {
  return tool.execute(input, { agent: { name: 'test', instructions: '' } });
}

describe('protocol emitters — tool shapes', () => {
  it('exposes the four expected tool names', () => {
    expect(emitScoutVerdict.name).toBe(EMIT_SCOUT_VERDICT_TOOL_NAME);
    expect(emitContract.name).toBe(EMIT_CONTRACT_TOOL_NAME);
    expect(emitHandoff.name).toBe(EMIT_HANDOFF_TOOL_NAME);
    expect(emitVerdict.name).toBe(EMIT_VERDICT_TOOL_NAME);
    expect(PROTOCOL_EMITTER_TOOLS).toHaveLength(4);
  });

  it('declares an execute function on each tool', () => {
    for (const tool of PROTOCOL_EMITTER_TOOLS) {
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('requires confirmed_harness on scout, status on generator/evaluator, success_criteria on planner', () => {
    expect(emitScoutVerdict.input_schema.required).toContain('confirmed_harness');
    expect(emitContract.input_schema.required).toContain('success_criteria');
    expect(emitHandoff.input_schema.required).toContain('status');
    expect(emitVerdict.input_schema.required).toContain('status');
  });

  it('enumerates the harness tier on scout and the status on evaluator', () => {
    const harnessEnum = (emitScoutVerdict.input_schema.properties as Record<string, { enum?: string[] }>)
      .confirmed_harness?.enum;
    expect(harnessEnum).toEqual(['H0_DIRECT', 'H1_EXECUTE_EVAL', 'H2_PLAN_EXECUTE_EVAL']);
    const verdictStatusEnum = (emitVerdict.input_schema.properties as Record<string, { enum?: string[] }>)
      .status?.enum;
    expect(verdictStatusEnum).toEqual(['accept', 'revise', 'blocked']);
  });
});

describe('protocol emitters — scout', () => {
  it('normalizes an H1 verdict with scope and confirmedHarness', async () => {
    const result = await runExecute(emitScoutVerdict, {
      summary: 'User wants to add a login endpoint',
      scope: ['src/auth/', 'src/server/routes.ts'],
      required_evidence: ['test/auth.test.ts'],
      confirmed_harness: 'H1_EXECUTE_EVAL',
      harness_rationale: 'Small scope, tests already in place',
    });
    expect(result.isError).toBeUndefined();
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.role).toBe('scout');
    expect(meta.payload.scout?.confirmedHarness).toBe('H1_EXECUTE_EVAL');
    expect(meta.payload.scout?.scope).toEqual(['src/auth/', 'src/server/routes.ts']);
    expect(meta.payload.scout?.requiredEvidence).toEqual(['test/auth.test.ts']);
  });

  it('accepts lowercase harness aliases and normalizes to canonical form', async () => {
    const result = await runExecute(emitScoutVerdict, { confirmed_harness: 'h0' });
    expect(result.isError).toBeUndefined();
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.payload.scout?.confirmedHarness).toBe('H0_DIRECT');
  });

  it('surfaces is_error when no normalizable fields are present', async () => {
    const result = await runExecute(emitScoutVerdict, {});
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/could not be normalized/);
  });

  it('produces a summary containing harness=X for the LLM to see', async () => {
    const result = await runExecute(emitScoutVerdict, {
      confirmed_harness: 'H2_PLAN_EXECUTE_EVAL',
      scope: ['x'],
    });
    expect(result.content).toMatch(/harness=H2_PLAN_EXECUTE_EVAL/);
  });
});

describe('protocol emitters — planner (contract)', () => {
  it('normalizes a contract with success_criteria + constraints', async () => {
    const result = await runExecute(emitContract, {
      summary: 'Add login endpoint with JWT',
      success_criteria: ['POST /auth/login works', 'Tests pass'],
      required_evidence: ['auth.test.ts output'],
      constraints: ['Use existing JWT utils in src/auth/token.ts'],
    });
    expect(result.isError).toBeUndefined();
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.role).toBe('planner');
    expect(meta.payload.contract?.successCriteria).toHaveLength(2);
    expect(meta.payload.contract?.constraints).toHaveLength(1);
  });

  it('surfaces is_error when all lists are empty and no summary', async () => {
    const result = await runExecute(emitContract, {
      success_criteria: [],
      required_evidence: [],
      constraints: [],
    });
    expect(result.isError).toBe(true);
  });
});

describe('protocol emitters — generator (handoff)', () => {
  it('normalizes a ready handoff with evidence + followup', async () => {
    const result = await runExecute(emitHandoff, {
      status: 'ready',
      summary: 'Done, tests pass',
      evidence: ['src/auth/login.ts', 'test/auth.test.ts passing'],
      followup: [],
    });
    expect(result.isError).toBeUndefined();
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.role).toBe('generator');
    expect(meta.payload.handoff?.status).toBe('ready');
    expect(meta.payload.handoff?.evidence).toHaveLength(2);
  });

  it('accepts "partial" as alias for incomplete', async () => {
    const result = await runExecute(emitHandoff, { status: 'partial' });
    expect(result.isError).toBeUndefined();
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.payload.handoff?.status).toBe('incomplete');
  });

  it('surfaces is_error on unknown status', async () => {
    const result = await runExecute(emitHandoff, { status: 'unknown-xyz' });
    expect(result.isError).toBe(true);
  });
});

describe('protocol emitters — evaluator (verdict)', () => {
  it('normalizes an accept verdict with user_answer', async () => {
    const result = await runExecute(emitVerdict, {
      status: 'accept',
      reason: 'All tests pass',
      user_answer: 'Login endpoint added at POST /auth/login.',
      followup: [],
    });
    expect(result.isError).toBeUndefined();
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.role).toBe('evaluator');
    expect(meta.payload.verdict?.status).toBe('accept');
    expect(meta.payload.verdict?.userAnswer).toMatch(/Login endpoint added/);
  });

  it('normalizes a revise verdict with next_harness escalation', async () => {
    const result = await runExecute(emitVerdict, {
      status: 'revise',
      reason: 'Scope larger than anticipated',
      next_harness: 'H2_PLAN_EXECUTE_EVAL',
    });
    expect(result.isError).toBeUndefined();
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.payload.verdict?.status).toBe('revise');
    expect(meta.payload.verdict?.nextHarness).toBe('H2_PLAN_EXECUTE_EVAL');
  });

  it('surfaces is_error when status is missing', async () => {
    const result = await runExecute(emitVerdict, { reason: 'no status' });
    expect(result.isError).toBe(true);
  });
});

describe('protocol emitters — handoff target resolution (Shard 4)', () => {
  it('scout H0_DIRECT → no handoffTarget, isTerminal=true', async () => {
    const result = await runExecute(emitScoutVerdict, { confirmed_harness: 'H0_DIRECT' });
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.handoffTarget).toBeUndefined();
    expect(meta.isTerminal).toBe(true);
  });

  it('scout H1_EXECUTE_EVAL → handoff to generator', async () => {
    const result = await runExecute(emitScoutVerdict, { confirmed_harness: 'H1_EXECUTE_EVAL' });
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.handoffTarget).toBe('kodax/role/generator');
    expect(meta.isTerminal).toBe(false);
  });

  it('scout H2_PLAN_EXECUTE_EVAL → handoff to planner', async () => {
    const result = await runExecute(emitScoutVerdict, { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL' });
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.handoffTarget).toBe('kodax/role/planner');
  });

  it('planner contract always → handoff to generator', async () => {
    const result = await runExecute(emitContract, { success_criteria: ['x'] });
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.handoffTarget).toBe('kodax/role/generator');
  });

  it('generator handoff always → handoff to evaluator', async () => {
    const result = await runExecute(emitHandoff, { status: 'ready' });
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.handoffTarget).toBe('kodax/role/evaluator');
  });

  it('evaluator accept → no handoffTarget, isTerminal=true', async () => {
    const result = await runExecute(emitVerdict, { status: 'accept', user_answer: 'done' });
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.handoffTarget).toBeUndefined();
    expect(meta.isTerminal).toBe(true);
  });

  it('evaluator blocked → no handoffTarget, isTerminal=true', async () => {
    const result = await runExecute(emitVerdict, { status: 'blocked', reason: 'needs auth' });
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.handoffTarget).toBeUndefined();
    expect(meta.isTerminal).toBe(true);
  });

  it('evaluator revise (default) → handoff to generator', async () => {
    const result = await runExecute(emitVerdict, { status: 'revise' });
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.handoffTarget).toBe('kodax/role/generator');
  });

  it('evaluator revise with next_harness=H2 → handoff to planner', async () => {
    const result = await runExecute(emitVerdict, { status: 'revise', next_harness: 'H2' });
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.handoffTarget).toBe('kodax/role/planner');
  });
});

describe('protocol emitters — parity with legacy parser', () => {
  it('scout payload is byte-equivalent to coerceManagedProtocolToolPayload output', async () => {
    const input = {
      confirmed_harness: 'H1_EXECUTE_EVAL',
      scope: ['a', 'b'],
      required_evidence: ['test.ts'],
      harness_rationale: 'small scope',
    };
    const result = await runExecute(emitScoutVerdict, input);
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    const legacy = coerceManagedProtocolToolPayload('scout', input);
    expect(meta.payload).toEqual(legacy);
  });

  it('evaluator payload is byte-equivalent to legacy for revise + next_harness', async () => {
    const input = { status: 'revise', next_harness: 'H2', reason: 'scope grew' };
    const result = await runExecute(emitVerdict, input);
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    const legacy = coerceManagedProtocolToolPayload('evaluator', input);
    expect(meta.payload).toEqual(legacy);
  });

  it('generator payload is byte-equivalent to legacy (partial → incomplete)', async () => {
    const input = { status: 'partial', evidence: ['e1'] };
    const result = await runExecute(emitHandoff, input);
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    const legacy = coerceManagedProtocolToolPayload('generator', input);
    expect(meta.payload).toEqual(legacy);
  });
});
