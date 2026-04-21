/**
 * Runner-driven path tests — FEATURE_084 Shard 5a (v0.7.26).
 *
 * Covers:
 *   - Env flag detection (`KODAX_MANAGED_TASK_RUNTIME=runner`)
 *   - Agent construction (Scout with emit + core tools, no handoffs for H0)
 *   - LLM adapter: system split, tool serialization, RunnerLlmResult shape
 *   - End-to-end Scout H0_DIRECT flow via mocked provider stream
 *   - KodaXResult shape: success + lastText + messages, no managedTask
 *     (matches SA fast-path semantics for Shard 5a; Shard 5b populates
 *     managedTask when Generator/Evaluator enter the chain)
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  EMIT_SCOUT_VERDICT_TOOL_NAME,
} from '../agents/protocol-emitters.js';
import {
  buildRunnerLlmAdapter,
  buildRunnerScoutAgent,
  isRunnerDrivenRuntimeEnabled,
  runManagedTaskViaRunner,
} from './runner-driven.js';
import type { KodaXMessage, KodaXToolDefinition, KodaXToolUseBlock } from '@kodax/ai';
import type { KodaXOptions, KodaXToolExecutionContext } from '../types.js';

function makeCtx(): KodaXToolExecutionContext {
  return {
    backups: new Map<string, string>(),
    gitRoot: process.cwd(),
    executionCwd: process.cwd(),
  };
}

function makeOptions(): KodaXOptions {
  return {
    provider: 'anthropic',
    context: { gitRoot: process.cwd(), executionCwd: process.cwd() },
    events: {},
  } as KodaXOptions;
}

describe('isRunnerDrivenRuntimeEnabled', () => {
  const envKey = 'KODAX_MANAGED_TASK_RUNTIME';
  afterEach(() => {
    delete process.env[envKey];
  });

  it('returns false when env var is unset', () => {
    delete process.env[envKey];
    expect(isRunnerDrivenRuntimeEnabled()).toBe(false);
  });

  it('returns true for "runner"', () => {
    process.env[envKey] = 'runner';
    expect(isRunnerDrivenRuntimeEnabled()).toBe(true);
  });

  it('returns true for "RUNNER" (case insensitive)', () => {
    process.env[envKey] = 'RUNNER';
    expect(isRunnerDrivenRuntimeEnabled()).toBe(true);
  });

  it('returns false for "legacy" or any other value', () => {
    process.env[envKey] = 'legacy';
    expect(isRunnerDrivenRuntimeEnabled()).toBe(false);
    process.env[envKey] = '1';
    expect(isRunnerDrivenRuntimeEnabled()).toBe(false);
  });
});

describe('buildRunnerScoutAgent', () => {
  it('carries emit_scout_verdict + 4 core coding tools', () => {
    const scout = buildRunnerScoutAgent(makeCtx());
    const names = scout.tools?.map((t) => t.name) ?? [];
    expect(names).toContain(EMIT_SCOUT_VERDICT_TOOL_NAME);
    expect(names).toContain('read');
    expect(names).toContain('grep');
    expect(names).toContain('glob');
    expect(names).toContain('bash');
  });

  it('declares handoffs to generator (H1) and planner (H2) — Shard 5b topology', () => {
    const scout = buildRunnerScoutAgent(makeCtx());
    const targets = (scout.handoffs ?? []).map((h) => h.target.name);
    expect(targets).toContain('kodax/role/generator');
    expect(targets).toContain('kodax/role/planner');
  });

  it('uses kodax/role/scout as the canonical agent name', () => {
    const scout = buildRunnerScoutAgent(makeCtx());
    expect(scout.name).toBe('kodax/role/scout');
  });

  it('carries a self-contained H0 instruction string (no ManagedRolePromptContext dependency)', () => {
    const scout = buildRunnerScoutAgent(makeCtx());
    expect(typeof scout.instructions).toBe('string');
    expect(scout.instructions).toMatch(/H0_DIRECT/);
    expect(scout.instructions).toMatch(/emit_scout_verdict/);
  });
});

describe('buildRunnerLlmAdapter (via overrideStream)', () => {
  it('splits leading system message and sends rest to the stream', async () => {
    let capturedSystem = '';
    let capturedTranscript: readonly KodaXMessage[] = [];
    const adapter = buildRunnerLlmAdapter(makeOptions(), async (transcript, _tools, system) => {
      capturedSystem = system;
      capturedTranscript = transcript;
      return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
    });
    await adapter(
      [
        { role: 'system', content: 'sys-text' },
        { role: 'user', content: 'user-q' },
      ],
      { name: 'x', instructions: 'ignored' },
    );
    expect(capturedSystem).toBe('sys-text');
    expect(capturedTranscript).toHaveLength(1);
    expect(capturedTranscript[0]!.content).toBe('user-q');
  });

  it('strips execute function from agent tools when serializing for the wire', async () => {
    let capturedTools: readonly { name: string; execute?: unknown }[] = [];
    const adapter = buildRunnerLlmAdapter(makeOptions(), async (_t, tools) => {
      capturedTools = tools as readonly { name: string; execute?: unknown }[];
      return { textBlocks: [], toolBlocks: [] };
    });
    const scout = buildRunnerScoutAgent(makeCtx());
    await adapter([{ role: 'system', content: 's' }], scout);
    for (const t of capturedTools) {
      expect(t.execute).toBeUndefined();
    }
    expect(capturedTools.some((t) => t.name === EMIT_SCOUT_VERDICT_TOOL_NAME)).toBe(true);
  });

  it('converts textBlocks+toolBlocks to RunnerLlmResult shape', async () => {
    const toolBlock: KodaXToolUseBlock = {
      type: 'tool_use',
      id: 'call_1',
      name: 'emit_scout_verdict',
      input: { confirmed_harness: 'H0_DIRECT' },
    };
    const adapter = buildRunnerLlmAdapter(makeOptions(), async () => ({
      textBlocks: [{ text: 'Calling verdict' }],
      toolBlocks: [toolBlock],
    }));
    const result = await adapter(
      [{ role: 'system', content: 's' }],
      { name: 'x', instructions: '' },
    );
    expect(result.text).toBe('Calling verdict');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe('emit_scout_verdict');
    expect(result.toolCalls![0]!.input).toEqual({ confirmed_harness: 'H0_DIRECT' });
  });
});

describe('runManagedTaskViaRunner — Scout H0_DIRECT end-to-end', () => {
  it('runs a Scout H0_DIRECT flow: emit_scout_verdict then final text', async () => {
    let turn = 0;
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'What is 2 + 2?',
      async (_transcript, _tools, _system) => {
        turn += 1;
        if (turn === 1) {
          return {
            textBlocks: [{ text: 'Simple arithmetic, answering directly.' }],
            toolBlocks: [
              {
                type: 'tool_use',
                id: 'scout-1',
                name: 'emit_scout_verdict',
                input: {
                  confirmed_harness: 'H0_DIRECT',
                  direct_completion_ready: 'yes',
                  summary: 'Arithmetic question',
                  scope: [],
                  required_evidence: [],
                  harness_rationale: 'Trivial math, no code inspection needed.',
                },
              },
            ],
          };
        }
        // Second turn: Scout sees tool_result, emits final text
        return { textBlocks: [{ text: '2 + 2 = 4.' }], toolBlocks: [] };
      },
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('2 + 2 = 4.');
    expect(result.signal).toBe('COMPLETE');
    // Shard 6a populates managedTask with a minimal but well-shaped payload.
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');

    // Transcript shape: system, user, assistant(tool_use), user(tool_result), assistant(final)
    expect(result.messages).toHaveLength(5);
    expect(result.messages[0]!.role).toBe('system');
    expect(result.messages[1]!.role).toBe('user');
    expect(result.messages[2]!.role).toBe('assistant');
    expect(result.messages[3]!.role).toBe('user');
    expect(result.messages[4]!.role).toBe('assistant');
  });

  it('handles a zero-tool direct answer (Scout answers without emit)', async () => {
    // Edge case: a minimalist Scout that just returns the answer as text,
    // without ever calling emit_scout_verdict. The run still completes;
    // managedTask is populated with defaults (harness=H0_DIRECT).
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Say hello',
      async () => ({ textBlocks: [{ text: 'Hello, world.' }], toolBlocks: [] }),
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('Hello, world.');
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
  });

  it('surfaces tool errors back to the LLM without failing the run', async () => {
    let turn = 0;
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Read /nonexistent/path',
      async (transcript) => {
        turn += 1;
        if (turn === 1) {
          return {
            textBlocks: [],
            toolBlocks: [
              {
                type: 'tool_use',
                id: 'read-1',
                name: 'read',
                input: { file_path: '/definitely/does/not/exist/xyz.txt' },
              },
            ],
          };
        }
        // Second turn: LLM sees the tool error and adapts.
        const last = transcript[transcript.length - 1]!;
        const blocks = last.content as Array<{ type: string; content: string; is_error?: boolean }>;
        expect(blocks[0]!.type).toBe('tool_result');
        // The read tool might fail with a specific error; either is_error
        // is true or content carries a "[Tool Error]" prefix.
        const errored = blocks[0]!.is_error === true
          || blocks[0]!.content.toLowerCase().includes('error')
          || blocks[0]!.content.toLowerCase().includes('enoent');
        expect(errored).toBe(true);
        return { textBlocks: [{ text: 'File does not exist; try a different path.' }], toolBlocks: [] };
      },
    );
    expect(result.success).toBe(true);
    expect(result.lastText).toMatch(/does not exist/);
  });
});

describe('parity — Runner path and legacy SA path produce compatible KodaXResult shape', () => {
  // The goal of Shard 5a parity is NOT byte-level equivalence (the legacy
  // AMA state machine emits dozens of observer events and populates a
  // full managedTask payload that the Shard 5a skeleton doesn't produce).
  // The goal IS user-facing shape parity: both paths return a KodaXResult
  // with success + lastText + messages + sessionId, and FEATURE_076's
  // round-boundary reshape can consume either one without special casing.
  it('runner-path KodaXResult is compatible with FEATURE_076 round-boundary reshape', async () => {
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Trivial task',
      async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    );

    // Required fields for reshape (see round-boundary.ts):
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.lastText).toBe('string');
    expect(Array.isArray(result.messages)).toBe(true);
    expect(typeof result.sessionId).toBe('string');
    // Shard 6a populates managedTask even on zero-tool runs.
    expect(result.managedTask?.verdict?.status).toBe('running');
  });
});

// =============================================================================
// Shard 5b parity matrix — 4 multi-agent canonical paths
// =============================================================================

/**
 * Helper: build a mock LLM that dispatches per agent name. Each agent's
 * turn handler receives the turn number (1-indexed per agent) and may
 * return a text-only response, a tool-calling response, or throw.
 */
type AgentTurn = (
  turnOfThisAgent: number,
  transcript: readonly KodaXMessage[],
) => {
  textBlocks?: readonly { text: string }[];
  toolBlocks?: readonly KodaXToolUseBlock[];
};

function makeChainMockLlm(handlers: Record<string, AgentTurn>) {
  const turnCount: Record<string, number> = {};
  // We can't see the agent name from the stream signature, but the system
  // message content tells us: it's the agent's instructions. We grep each
  // role's distinct marker.
  const detectRole = (system: string): string => {
    if (system.includes('You are Scout')) return 'scout';
    if (system.includes('You are Planner')) return 'planner';
    if (system.includes('You are Generator')) return 'generator';
    if (system.includes('You are Evaluator')) return 'evaluator';
    return 'unknown';
  };
  return async (
    transcript: readonly KodaXMessage[],
    _tools: readonly KodaXToolDefinition[],
    system: string,
  ) => {
    const role = detectRole(system);
    turnCount[role] = (turnCount[role] ?? 0) + 1;
    const handler = handlers[role];
    if (!handler) throw new Error(`No mock handler for role ${role}`);
    return handler(turnCount[role]!, transcript);
  };
}

describe('Shard 5b parity — H1 accept path', () => {
  it('Scout → Generator → Evaluator accept produces converged KodaXResult', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use',
              id: 'scout-1',
              name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL', harness_rationale: 'small scope' },
            }],
          };
        }
        throw new Error('scout should have handed off already');
      },
      generator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use',
              id: 'gen-1',
              name: 'emit_handoff',
              input: { status: 'ready', summary: 'Done', evidence: ['test passes'] },
            }],
          };
        }
        throw new Error('generator should have handed off already');
      },
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use',
              id: 'eval-1',
              name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Feature implemented and tests pass.' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Feature implemented and tests pass.' }] };
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'Add login endpoint', mock);
    expect(result.success).toBe(true);
    expect(result.signal).toBe('COMPLETE');
    expect(result.lastText).toBe('Feature implemented and tests pass.');
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
    expect(result.managedProtocolPayload?.scout?.confirmedHarness).toBe('H1_EXECUTE_EVAL');
    expect(result.managedProtocolPayload?.handoff?.status).toBe('ready');
  });
});

describe('Shard 5b parity — H1 revise → accept path', () => {
  it('Evaluator revise cycles back to Generator, then accept on second pass', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      generator: (turn) => {
        if (turn === 1 || turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: `g${turn}`, name: 'emit_handoff',
              input: { status: 'ready' },
            }],
          };
        }
        throw new Error('generator overrun');
      },
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'revise', reason: 'missed edge case' },
            }],
          };
        }
        if (turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e2', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Fixed on second pass.' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Fixed on second pass.' }] };
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'Fix edge case', mock);
    expect(result.success).toBe(true);
    expect(result.lastText).toBe('Fixed on second pass.');
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });
});

describe('Shard 5b parity — H2 plan → execute → accept path', () => {
  it('Scout → Planner → Generator → Evaluator accept with contract', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL', harness_rationale: 'larger scope' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      planner: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'p1', name: 'emit_contract',
              input: {
                summary: 'Add JWT auth',
                success_criteria: ['POST /auth/login works', 'tests pass'],
                required_evidence: ['auth.test.ts passing'],
                constraints: ['use existing token utils'],
              },
            }],
          };
        }
        throw new Error('planner overrun');
      },
      generator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'g1', name: 'emit_handoff',
              input: { status: 'ready', evidence: ['tests passing'] },
            }],
          };
        }
        throw new Error('generator overrun');
      },
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'JWT auth ready per contract.' },
            }],
          };
        }
        return { textBlocks: [{ text: 'JWT auth ready per contract.' }] };
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'Add JWT auth', mock);
    expect(result.success).toBe(true);
    expect(result.lastText).toBe('JWT auth ready per contract.');
    expect(result.managedProtocolPayload?.scout?.confirmedHarness).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(result.managedProtocolPayload?.contract?.successCriteria).toHaveLength(2);
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });
});

describe('Shard 5b parity — blocked path', () => {
  it('Evaluator blocked surfaces BLOCKED signal + reason; success=false', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      generator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'g1', name: 'emit_handoff',
              input: { status: 'blocked', summary: 'needs OAuth config' },
            }],
          };
        }
        throw new Error('generator overrun');
      },
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'blocked', reason: 'Missing OAUTH_CLIENT_ID env var' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Blocked: needs OAUTH_CLIENT_ID to be set.' }] };
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'Enable OAuth', mock);
    expect(result.success).toBe(false);
    expect(result.signal).toBe('BLOCKED');
    expect(result.signalReason).toMatch(/OAUTH_CLIENT_ID/);
    expect(result.managedProtocolPayload?.verdict?.status).toBe('blocked');
  });
});

// =============================================================================
// Shard 6a — Observer events + managedTask payload
// =============================================================================

describe('Shard 6a — onManagedTaskStatus observer events', () => {
  it('fires preflight at start and completed at end', async () => {
    const statuses: Array<{ phase?: string; activeWorkerId?: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: { phase?: string; activeWorkerId?: string }) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    await runManagedTaskViaRunner(opts, 'Say hi', async () => ({
      textBlocks: [{ text: 'Hi.' }], toolBlocks: [],
    }));
    expect(statuses.some((s) => s.phase === 'preflight')).toBe(true);
    expect(statuses.some((s) => s.phase === 'completed')).toBe(true);
  });

  it('fires round events per role emit (Scout → Gen → Eval → accept)', async () => {
    const statuses: Array<{ phase?: string; activeWorkerId?: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: { phase?: string; activeWorkerId?: string }) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Done' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Done' }] };
      },
    });
    await runManagedTaskViaRunner(opts, 'task', mock);
    const roleEvents = statuses.filter((s) => s.phase === 'round').map((s) => s.activeWorkerId);
    expect(roleEvents).toContain('scout');
    expect(roleEvents).toContain('generator');
    expect(roleEvents).toContain('evaluator');
  });

  it('fires completed with BLOCKED signal note on blocked verdict', async () => {
    const statuses: Array<{ phase?: string; note?: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: { phase?: string; note?: string }) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'blocked' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'blocked', reason: 'missing dependency' },
            }],
          };
        }
        return { textBlocks: [{ text: 'blocked' }] };
      },
    });
    await runManagedTaskViaRunner(opts, 'task', mock);
    const completed = statuses.find((s) => s.phase === 'completed');
    expect(completed?.note).toMatch(/blocked/);
  });
});

describe('Shard 6a — managedTask payload shape', () => {
  it('populates contract.harnessProfile from Scout verdict (H1 case)', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'ok' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.managedTask?.contract.harnessProfile).toBe('H1_EXECUTE_EVAL');
    expect(result.managedTask?.contract.surface).toBe('cli');
    expect(result.managedTask?.contract.objective).toBe('task');
  });

  it('populates roleAssignments in handoff order (H2 chain)', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL' },
        }],
      }),
      planner: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 'p1', name: 'emit_contract',
          input: { success_criteria: ['c1'] },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'done' },
            }],
          };
        }
        return { textBlocks: [{ text: 'done' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    const roles = result.managedTask?.roleAssignments.map((a) => a.role);
    expect(roles).toEqual(['scout', 'planner', 'generator', 'evaluator']);
  });

  it('populates single "direct" assignment for H0_DIRECT', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT', direct_completion_ready: 'yes' },
            }],
          };
        }
        return { textBlocks: [{ text: 'direct answer' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'trivial', mock);
    const roles = result.managedTask?.roleAssignments.map((a) => a.role);
    expect(roles).toEqual(['direct']);
    expect(result.managedTask?.verdict.decidedByAssignmentId).toBe('direct');
  });

  it('populates runtime.globalWorkBudget + budgetUsage (Shard 6a minimum)', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'ok' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(400); // H1
    expect(result.managedTask?.runtime?.budgetUsage).toBeGreaterThan(0);
  });

  it('records harnessTransitions when Scout chooses non-H0 tier', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL' },
        }],
      }),
      planner: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 'p1', name: 'emit_contract',
          input: { success_criteria: ['x'] },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'done' },
            }],
          };
        }
        return { textBlocks: [{ text: 'done' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    const transitions = result.managedTask?.runtime?.harnessTransitions ?? [];
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.from).toBe('H0_DIRECT');
    expect(transitions[0]!.to).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(transitions[0]!.source).toBe('scout');
  });

  it('verdict.status=completed on accept, blocked on blocked', async () => {
    const acceptMock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'ok' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
    });
    const accept = await runManagedTaskViaRunner(makeOptions(), 'task', acceptMock);
    expect(accept.managedTask?.verdict.status).toBe('completed');

    const blockedMock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'blocked' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'blocked', reason: 'need env var' },
            }],
          };
        }
        return { textBlocks: [{ text: 'blocked' }] };
      },
    });
    const blocked = await runManagedTaskViaRunner(makeOptions(), 'task', blockedMock);
    expect(blocked.managedTask?.verdict.status).toBe('blocked');
  });
});

// =============================================================================
// Shard 6b — Real budget tracking + mutation tracker
// =============================================================================

describe('Shard 6b — budget controller', () => {
  it('increments spentBudget per tool invocation (emit tools count)', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'ok' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    // 3 emit tool calls (scout + handoff + verdict) → at least 3 budget units
    expect(result.managedTask?.runtime?.budgetUsage).toBeGreaterThanOrEqual(3);
  });

  it('upgrades totalBudget when Scout picks H1 (from 50 → 400)', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'ok' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(400);
  });

  it('keeps H0 budget (50) when Scout chooses H0_DIRECT', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT', direct_completion_ready: 'yes' },
            }],
          };
        }
        return { textBlocks: [{ text: 'direct answer' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'trivial', mock);
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(50);
  });

  it('upgrades to 600 when Scout picks H2', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL' },
        }],
      }),
      planner: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 'p1', name: 'emit_contract',
          input: { success_criteria: ['x'] },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'done' },
            }],
          };
        }
        return { textBlocks: [{ text: 'done' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(600);
  });
});

describe('Shard 6b — mutation tracker', () => {
  // Mutation tracking hooks run when Generator invokes write/edit/bash.
  // We test by having the mock Generator call the `write` tool, then
  // verify the tracker accumulated the file entry.
  //
  // Note: the tracker is internal to the run. It's observable via the
  // scope-awareness note that `emit_scout_verdict` appends when H0 is
  // declared with >3 mutations (legacy behavior). For Shard 6b we only
  // assert the plumbing works end-to-end by checking that the write
  // tool call returns successfully — this exercises the
  // recordMutationForTool codepath without adding new assertions.
  it('write tool execution does not crash under the Runner-driven path', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: (turn) => {
        if (turn === 1) {
          // Call write with a path that won't actually exist; we only care
          // that the mutation hook runs (records via recordMutationForTool).
          // The tool will error, which is fine — we're testing plumbing,
          // not end-to-end write success.
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'w1', name: 'write',
              input: {
                file_path: '/tmp/kodax-runner-driven-test-nowrite.txt',
                content: 'line1\nline2\nline3\n',
              },
            }],
          };
        }
        return {
          toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
        };
      },
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'done' },
            }],
          };
        }
        return { textBlocks: [{ text: 'done' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.success).toBe(true);
    // Budget usage reflects scout emit + write tool + handoff emit + verdict emit ≥ 4
    expect(result.managedTask?.runtime?.budgetUsage).toBeGreaterThanOrEqual(4);
  });
});

// =============================================================================
// Shard 6c — Checkpoint recovery (FEATURE_071)
// =============================================================================

describe('Shard 6c — checkpoint handling', () => {
  it('completes a run that has no pre-existing checkpoint without error', async () => {
    // Smoke: the happy-path "no checkpoint" branch in handlePreRunCheckpoint.
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT', direct_completion_ready: 'yes' },
            }],
          };
        }
        return { textBlocks: [{ text: 'done' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.success).toBe(true);
  });

  it('completes the full H1 chain even with checkpoint writes firing per role', async () => {
    // Exercises the fire-and-forget checkpoint writer during a multi-role
    // run. Failures inside writeCurrentCheckpoint are swallowed, so even
    // if the workspace-root is unwritable the chain completes.
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'ok' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.success).toBe(true);
    // roleAssignments records all 3 roles that emitted.
    expect(result.managedTask?.roleAssignments.map((a) => a.role)).toEqual([
      'scout', 'generator', 'evaluator',
    ]);
  });
});

describe('Shard 5b — H2 replan via nextHarness', () => {
  it('Evaluator revise with next_harness=H2 routes back to Planner', async () => {
    let plannerTurns = 0;
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      planner: (turn) => {
        plannerTurns += 1;
        return {
          toolBlocks: [{
            type: 'tool_use', id: `p${turn}`, name: 'emit_contract',
            input: {
              summary: `Plan v${turn}`,
              success_criteria: ['criteria1'],
              required_evidence: [],
              constraints: [],
            },
          }],
        };
      },
      generator: (turn) => {
        return {
          toolBlocks: [{
            type: 'tool_use', id: `g${turn}`, name: 'emit_handoff',
            input: { status: 'ready' },
          }],
        };
      },
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'revise', next_harness: 'H2_PLAN_EXECUTE_EVAL' },
            }],
          };
        }
        if (turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e2', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Replanned and succeeded.' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Replanned and succeeded.' }] };
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'Complex task', mock);
    expect(plannerTurns).toBeGreaterThanOrEqual(2);
    expect(result.success).toBe(true);
    expect(result.lastText).toBe('Replanned and succeeded.');
  });
});
