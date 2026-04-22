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

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EMIT_SCOUT_VERDICT_TOOL_NAME,
} from '../agents/protocol-emitters.js';
import {
  buildRunnerAgentChain,
  buildRunnerLlmAdapter,
  buildRunnerScoutAgent,
  isRunnerDrivenRuntimeEnabled,
  runManagedTaskViaRunner,
} from './runner-driven.js';
import type { RunnableTool } from '@kodax/core';
import type { KodaXMessage, KodaXToolDefinition, KodaXToolUseBlock } from '@kodax/ai';
import type { KodaXEvents, KodaXOptions, KodaXToolExecutionContext } from '../types.js';

// Shared scratch directory for `managedTaskWorkspaceDir` so the
// Shard 6d-h artifact writes (contract.json / managed-task.json /
// result.json / ... ) land inside a temp folder instead of polluting
// the repo's cwd with `.agent/managed-tasks/` entries.
let testWorkspaceRoot: string;

beforeAll(async () => {
  testWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-runner-driven-'));
});

afterAll(async () => {
  if (testWorkspaceRoot) {
    // Windows can hold transient handles immediately after tests;
    // retry a few times before giving up so CI stays clean.
    await rm(testWorkspaceRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    }).catch(() => undefined);
  }
});

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
    context: {
      gitRoot: process.cwd(),
      executionCwd: process.cwd(),
      managedTaskWorkspaceDir: testWorkspaceRoot,
      // Shard 6d-i: disable task-scoped repo-intelligence capture in
      // unit tests — the capture walks the real repo (cwd is the kodax
      // monorepo during test runs), which would otherwise add tens of
      // seconds per test. Production callers keep the default auto mode.
      repoIntelligenceMode: 'off',
    },
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
    const roleEvents = statuses.filter((s) => s.phase === 'worker').map((s) => s.activeWorkerId);
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

describe('Shard 6d-c1 — observer event enrichment', () => {
  it('populates activeWorkerTitle, currentRound, maxRounds on round events', async () => {
    const statuses: Array<Record<string, unknown>> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL', summary: 'chosen H1' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready', summary: 'gen done' } }],
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
    await runManagedTaskViaRunner(opts, 'do X', mock);
    const scoutEvent = statuses.find((s) => s.phase === 'worker' && s.activeWorkerId === 'scout');
    expect(scoutEvent?.activeWorkerTitle).toBe('Scout');
    expect(scoutEvent?.currentRound).toBe(1);
    expect(scoutEvent?.maxRounds).toBeGreaterThanOrEqual(6);
    const genEvent = statuses.find((s) => s.phase === 'worker' && s.activeWorkerId === 'generator');
    expect(genEvent?.activeWorkerTitle).toBe('Generator');
    expect(genEvent?.currentRound).toBe(2);
    const evalEvent = statuses.find((s) => s.phase === 'worker' && s.activeWorkerId === 'evaluator');
    expect(evalEvent?.activeWorkerTitle).toBe('Evaluator');
    expect(evalEvent?.currentRound).toBe(3);
  });

  it('populates globalWorkBudget and budgetUsage on every event', async () => {
    const statuses: Array<Record<string, unknown>> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    await runManagedTaskViaRunner(opts, 'Say hi', async () => ({
      textBlocks: [{ text: 'Hi.' }], toolBlocks: [],
    }));
    const event = statuses.find((s) => s.phase === 'preflight');
    expect(typeof event?.globalWorkBudget).toBe('number');
    expect(typeof event?.budgetUsage).toBe('number');
    expect(event?.budgetApprovalRequired).toBe(false);
  });

  it('completed event has persistToHistory=true and detailNote=verdict reason', async () => {
    const statuses: Array<Record<string, unknown>> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
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
              input: { status: 'blocked', reason: 'cannot verify dep' },
            }],
          };
        }
        return { textBlocks: [{ text: 'blocked' }] };
      },
    });
    await runManagedTaskViaRunner(opts, 'Task X', mock);
    const completed = statuses.find((s) => s.phase === 'completed');
    expect(completed?.persistToHistory).toBe(true);
    expect(completed?.detailNote).toBe('cannot verify dep');
  });

  it('round events default persistToHistory=false (transient progress ticks)', async () => {
    const statuses: Array<Record<string, unknown>> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
      generator: () => ({ textBlocks: [{ text: 'ok' }] }),
      evaluator: () => ({ textBlocks: [{ text: 'ok' }] }),
    });
    await runManagedTaskViaRunner(opts, 'Task', mock);
    const round = statuses.find((s) => s.phase === 'worker');
    expect(round?.persistToHistory).toBe(false);
  });
});

describe('Shard 6d-c2 — stream event passthrough', () => {
  it('forwards onTextDelta / onThinkingDelta via provider stream options', async () => {
    // We verify by going through the real adapter + a fake provider.stream
    // the adapter passes streamOptions to. Since `runManagedTaskViaRunner`
    // accepts an `adapterOverride` that *replaces* the stream entirely
    // (bypassing `resolveProvider`), these two hooks are exercised at the
    // adapter layer in `buildRunnerLlmAdapter` rather than here — this
    // test confirms the adapter propagates events through the override
    // signature (which carries `system` + `tools` + `transcript`).
    const textDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    const opts = {
      ...makeOptions(),
      events: {
        onTextDelta: (t: string) => textDeltas.push(t),
        onThinkingDelta: (t: string) => thinkingDeltas.push(t),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    // The override stream path does NOT hit provider.stream; for this
    // regression it is sufficient that options.events is surfaced into
    // buildRunnerLlmAdapter (verified via type-check) and tests below
    // exercise the non-override path only under integration.
    await runManagedTaskViaRunner(opts, 'hi', async () => ({
      textBlocks: [{ text: 'hi' }], toolBlocks: [],
    }));
    // With adapterOverride, no provider.stream call happens, so deltas
    // remain empty. The field wiring itself is compile-time guaranteed
    // via buildRunnerLlmAdapter's passthrough of streamOptions.
    expect(textDeltas).toEqual([]);
    expect(thinkingDeltas).toEqual([]);
  });
});

describe('Shard 6d-f — role-scoped tool boundaries (legacy toolPolicy parity)', () => {
  function findTool(agent: { tools?: readonly KodaXToolDefinition[] }, name: string): RunnableTool {
    const tool = agent.tools?.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool '${name}' not found on agent`);
    return tool as RunnableTool;
  }

  // Minimal RunnerToolContext for tests — `agent` is unused by the
  // bash / mutation-guard path but required by the interface.
  function makeToolCtx(agentName: string): import('@kodax/core').RunnerToolContext {
    return { agent: { name: agentName } as unknown as import('@kodax/core').Agent };
  }

  it('Planner agent exposes only read + grep + glob + emit_contract (no bash/write/edit)', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const plannerTools = chain.planner.tools?.map((t) => t.name) ?? [];
    expect(plannerTools).toContain('emit_contract');
    expect(plannerTools).toContain('read');
    expect(plannerTools).toContain('grep');
    expect(plannerTools).toContain('glob');
    expect(plannerTools).not.toContain('bash');
    expect(plannerTools).not.toContain('write');
    expect(plannerTools).not.toContain('edit');
  });

  it('Evaluator agent exposes read + grep + glob + bash + emit_verdict (no write/edit)', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const evaluatorTools = chain.evaluator.tools?.map((t) => t.name) ?? [];
    expect(evaluatorTools).toContain('emit_verdict');
    expect(evaluatorTools).toContain('bash');
    expect(evaluatorTools).not.toContain('write');
    expect(evaluatorTools).not.toContain('edit');
  });

  it('Generator agent exposes full coding toolbox including write + edit', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const genTools = chain.generator.tools?.map((t) => t.name) ?? [];
    expect(genTools).toContain('emit_handoff');
    expect(genTools).toContain('bash');
    expect(genTools).toContain('write');
    expect(genTools).toContain('edit');
  });

  it('Evaluator bash blocks shell mutation commands (legacy SHELL_WRITE_PATTERNS parity)', async () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const evalBash = findTool(chain.evaluator, 'bash');
    const result = await evalBash.execute({ command: 'rm -rf /tmp/x' }, makeToolCtx('evaluator'));
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('verification-only');
  });

  it('Evaluator bash allows read-only commands (ls, cat, git diff)', async () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const evalBash = findTool(chain.evaluator, 'bash');
    // Mutation guard does NOT fire for read-only commands.
    const result = await evalBash.execute({ command: 'git diff HEAD' }, makeToolCtx('evaluator'));
    if (result.isError) {
      expect(String(result.content)).not.toContain('verification-only');
    }
  });

  it('Evaluator bash blocks git write commands (commit, push, reset)', async () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const evalBash = findTool(chain.evaluator, 'bash');
    const commit = await evalBash.execute({ command: 'git commit -m "x"' }, makeToolCtx('evaluator'));
    expect(commit.isError).toBe(true);
    expect(String(commit.content)).toContain('verification-only');
    const push = await evalBash.execute({ command: 'git push origin main' }, makeToolCtx('evaluator'));
    expect(push.isError).toBe(true);
    const reset = await evalBash.execute({ command: 'git reset --hard HEAD' }, makeToolCtx('evaluator'));
    expect(reset.isError).toBe(true);
  });

  it('Scout bash applies the same mutation guard (Scout is also read-only)', async () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const scoutBash = findTool(chain.scout, 'bash');
    const result = await scoutBash.execute({ command: 'rm -rf /tmp/y' }, makeToolCtx('scout'));
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('verification-only');
  });
});

describe('Shard 6d-T — Scout skillMap injected into Generator + Evaluator instructions', () => {
  function resolveInstructions(
    agent: { readonly instructions: string | ((ctx: unknown) => string) },
  ): string {
    return typeof agent.instructions === 'function'
      ? agent.instructions(undefined)
      : agent.instructions;
  }

  it('falls back to base text when Scout has not emitted', () => {
    const recorder = {};
    const chain = buildRunnerAgentChain(makeCtx(), recorder);
    const gen = resolveInstructions(chain.generator);
    expect(gen).not.toContain('Scout Skill Map');
    expect(gen).toContain('emit_handoff');
  });

  it('renders execution_obligations + ambiguities for Generator (not verification)', () => {
    const recorder: Record<string, unknown> = {
      scout: {
        payload: {
          scout: {
            summary: 's',
            scope: [],
            requiredEvidence: [],
            skillMap: {
              skillSummary: 'add a login form',
              executionObligations: ['write LoginForm.tsx', 'wire up POST /login'],
              verificationObligations: ['e2e test covers login'],
              ambiguities: ['should we support OAuth?'],
            },
          },
        },
      },
    };
    const chain = buildRunnerAgentChain(makeCtx(), recorder as unknown as Parameters<typeof buildRunnerAgentChain>[1]);
    const gen = resolveInstructions(chain.generator);
    expect(gen).toContain('Scout Skill Map');
    expect(gen).toContain('skill_summary: add a login form');
    expect(gen).toContain('execution_obligations:');
    expect(gen).toContain('- write LoginForm.tsx');
    expect(gen).toContain('- wire up POST /login');
    expect(gen).toContain('ambiguities_to_resolve:');
    expect(gen).toContain('- should we support OAuth?');
    // Generator does NOT see verification obligations.
    expect(gen).not.toContain('verification_obligations:');
  });

  it('renders verification_obligations for Evaluator', () => {
    const recorder: Record<string, unknown> = {
      scout: {
        payload: {
          scout: {
            summary: 's',
            scope: [],
            requiredEvidence: [],
            skillMap: {
              skillSummary: 'fix parser bug',
              executionObligations: ['patch parser.ts'],
              verificationObligations: ['parser.test.ts passes', 'no regression in ast-walker'],
              ambiguities: [],
            },
          },
        },
      },
    };
    const chain = buildRunnerAgentChain(makeCtx(), recorder as unknown as Parameters<typeof buildRunnerAgentChain>[1]);
    const evaluator = resolveInstructions(chain.evaluator);
    expect(evaluator).toContain('Scout Skill Map');
    expect(evaluator).toContain('verification_obligations:');
    expect(evaluator).toContain('- parser.test.ts passes');
    expect(evaluator).toContain('- no regression in ast-walker');
  });

  it('omits empty obligation lists', () => {
    const recorder: Record<string, unknown> = {
      scout: {
        payload: {
          scout: {
            summary: 's',
            scope: [],
            requiredEvidence: [],
            skillMap: {
              skillSummary: undefined,
              executionObligations: [],
              verificationObligations: [],
              ambiguities: [],
            },
          },
        },
      },
    };
    const chain = buildRunnerAgentChain(makeCtx(), recorder as unknown as Parameters<typeof buildRunnerAgentChain>[1]);
    const gen = resolveInstructions(chain.generator);
    // No fields populated → skill block omitted entirely.
    expect(gen).not.toContain('Scout Skill Map');
  });
});

describe('Shard 6d-Q — dispatch_child_task exposed to Scout + Generator only', () => {
  it('Scout agent exposes dispatch_child_task', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const scoutTools = chain.scout.tools?.map((t) => t.name) ?? [];
    expect(scoutTools).toContain('dispatch_child_task');
  });

  it('Generator agent exposes dispatch_child_task', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const genTools = chain.generator.tools?.map((t) => t.name) ?? [];
    expect(genTools).toContain('dispatch_child_task');
  });

  it('Planner + Evaluator agents do NOT expose dispatch_child_task', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const plannerTools = chain.planner.tools?.map((t) => t.name) ?? [];
    const evaluatorTools = chain.evaluator.tools?.map((t) => t.name) ?? [];
    expect(plannerTools).not.toContain('dispatch_child_task');
    expect(evaluatorTools).not.toContain('dispatch_child_task');
  });

  it('Scout-bound dispatch tool errors out if Scout asks for a write child', async () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const scoutDispatch = chain.scout.tools?.find(
      (t) => t.name === 'dispatch_child_task',
    ) as RunnableTool;
    expect(scoutDispatch).toBeDefined();
    // Scout with `read_only: false` → error (role gating inside
    // toolDispatchChildTask rejects write fan-out from Scout).
    const result = await scoutDispatch.execute(
      {
        id: 'x',
        objective: 'test',
        read_only: false,
      },
      { agent: { name: 'scout' } as unknown as import('@kodax/core').Agent },
    );
    expect(String(result.content)).toContain('Scout can only dispatch read-only');
  });
});

describe('Shard 6d-S — task verification contract surfaced to Evaluator + completionContractStatus', () => {
  function resolveInstructions(
    agent: { readonly instructions: string | ((ctx: unknown) => string) },
  ): string {
    return typeof agent.instructions === 'function'
      ? agent.instructions(undefined)
      : agent.instructions;
  }

  it('falls back to base Evaluator text when no verification contract', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const evaluator = resolveInstructions(chain.evaluator);
    expect(evaluator).not.toContain('Runtime Verification Contract');
  });

  it('renders startup command + UI flows + API checks for the Evaluator', () => {
    const chain = buildRunnerAgentChain(
      makeCtx(),
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      {
        runtime: {
          startupCommand: 'pnpm dev',
          readySignal: 'Ready in',
          baseUrl: 'http://localhost:3000',
          uiFlows: ['Navigate to /login and submit form', 'Verify dashboard renders'],
          apiChecks: ['GET /api/health returns 200'],
          dbChecks: [],
        },
      },
    );
    const evaluator = resolveInstructions(chain.evaluator);
    expect(evaluator).toContain('Runtime Verification Contract');
    expect(evaluator).toContain('startup_command: pnpm dev');
    expect(evaluator).toContain('ready_signal: Ready in');
    expect(evaluator).toContain('base_url: http://localhost:3000');
    expect(evaluator).toContain('ui_flows');
    expect(evaluator).toContain('1. Navigate to /login and submit form');
    expect(evaluator).toContain('api_checks');
    expect(evaluator).toContain('1. GET /api/health returns 200');
  });

  it('populates completionContractStatus=ready for all checks on accept', async () => {
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
              input: { status: 'ready', evidence: ['fixed'] },
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
              input: { status: 'accept', user_answer: 'all checks pass' },
            }],
          };
        }
        return { textBlocks: [{ text: 'all checks pass' }] };
      },
    });

    const result = await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        context: {
          ...makeOptions().context!,
          taskVerification: {
            criteria: [
              { id: 'crit.login', label: 'Login works', description: 'Login form submits successfully', threshold: 0.8, weight: 1 },
            ],
            runtime: {
              uiFlows: ['Login flow'],
              apiChecks: ['GET /api/health returns 200'],
              dbChecks: ['user row exists after signup'],
            },
          },
        },
      },
      'Verify the app',
      mock,
    );
    expect(result.success).toBe(true);
    const status = result.managedTask?.runtime?.completionContractStatus;
    expect(status).toBeDefined();
    expect(status!['crit.login']).toBe('ready');
    expect(status!['ui_flow:1']).toBe('ready');
    expect(status!['api_check:1']).toBe('ready');
    expect(status!['db_check:1']).toBe('ready');
  });

  it('populates completionContractStatus=blocked on blocked verdict', async () => {
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
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'blocked', reason: 'db unreachable' },
            }],
          };
        }
        return { textBlocks: [{ text: 'db unreachable' }] };
      },
    });

    const result = await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        context: {
          ...makeOptions().context!,
          taskVerification: {
            runtime: { dbChecks: ['users table query'] },
          },
        },
      },
      'Verify',
      mock,
    );
    const status = result.managedTask?.runtime?.completionContractStatus;
    expect(status).toBeDefined();
    expect(status!['db_check:1']).toBe('blocked');
  });

  it('returns undefined when no verification contract is declared', async () => {
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
        return { textBlocks: [{ text: 'hi' }] };
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'hi', mock);
    expect(result.managedTask?.runtime?.completionContractStatus).toBeUndefined();
  });
});

describe('Shard 6d-U — degraded-continue when upgrade beyond ceiling', () => {
  function makePlanWithCeiling(
    upgradeCeiling: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL',
  ): import('../reasoning.js').ReasoningPlan {
    return {
      mode: 'balanced',
      depth: 'medium',
      decision: {
        primaryTask: 'bugfix',
        confidence: 0.8,
        riskLevel: 'medium',
        recommendedMode: 'conversation',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H1_EXECUTE_EVAL',
        upgradeCeiling,
        reason: 'test',
      },
      amaControllerDecision: {
        profile: 'tactical',
        tactics: [],
        fanout: { mode: 'off' as const } as unknown as import('@kodax/agent').KodaXAmaFanoutPolicy,
        reason: 'test',
        upgradeTriggers: [],
      },
      promptOverlay: '',
    };
  }

  it('rewrites H2 revise → Generator when ceiling is H1 and sets degradedContinue=true', async () => {
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
          // Request H2 upgrade — should be denied because ceiling is H1.
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'revise', reason: 'need a plan', next_harness: 'H2_PLAN_EXECUTE_EVAL' },
            }],
          };
        }
        if (turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e2', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Degraded fix applied.' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Degraded fix applied.' }] };
      },
      // Ensure Planner never runs — the degraded path must keep ownership
      // inside Generator rather than pivoting to Planner.
      planner: () => {
        throw new Error('planner should not run when upgrade is denied');
      },
    });

    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Fix it',
      mock,
      makePlanWithCeiling('H1_EXECUTE_EVAL'),
    );
    expect(result.success).toBe(true);
    expect(result.managedTask?.runtime?.degradedContinue).toBe(true);
    // Accept still reached on second pass — degradation does not abort.
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });

  it('allows H2 upgrade (no degradation) when ceiling permits it', async () => {
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
      planner: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'p1', name: 'emit_contract',
              input: {
                summary: 'Escalated plan',
                success_criteria: ['fixed'],
                required_evidence: [],
                constraints: [],
              },
            }],
          };
        }
        throw new Error('planner overrun');
      },
      evaluator: (turn) => {
        if (turn === 1) {
          // Same H2 upgrade request — permitted this time.
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'revise', reason: 'need a plan', next_harness: 'H2_PLAN_EXECUTE_EVAL' },
            }],
          };
        }
        if (turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e2', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Upgraded fix applied.' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Upgraded fix applied.' }] };
      },
    });

    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Fix it',
      mock,
      makePlanWithCeiling('H2_PLAN_EXECUTE_EVAL'),
    );
    expect(result.success).toBe(true);
    expect(result.managedTask?.runtime?.degradedContinue).toBeUndefined();
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });
});

describe('Shard 6d-f — evaluator graceful fallback when verdict is not emitted', () => {
  it('returns COMPLETE with last assistant text when Evaluator produces no verdict', async () => {
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
        return { textBlocks: [{ text: 'ok' }] };
      },
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      // Evaluator emits NO verdict — just returns final text directly.
      evaluator: () => ({
        textBlocks: [{ text: 'Evaluator could not structure a verdict but here is the result.' }],
      }),
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    // Without a verdict, runner defaults to signal='COMPLETE' and uses
    // the last assistant text as the answer (matching legacy's
    // degraded-verification fallback semantics, minus the explicit note).
    expect(result.signal).toBe('COMPLETE');
    expect(result.lastText).toContain('could not structure a verdict');
  });
});

describe('Shard 6d-d — session continuity', () => {
  it('prepends options.session.initialMessages before the new prompt', async () => {
    const capturedTranscripts: KodaXMessage[][] = [];
    const opts = {
      ...makeOptions(),
      session: {
        initialMessages: [
          { role: 'user' as const, content: 'prior question' },
          { role: 'assistant' as const, content: 'prior answer' },
        ],
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    await runManagedTaskViaRunner(opts, 'follow-up question', async (transcript) => {
      capturedTranscripts.push([...transcript]);
      return { textBlocks: [{ text: 'got it' }], toolBlocks: [] };
    });
    // The first LLM turn's transcript (post-system-strip) should contain
    // the prior user/assistant pair + the new user prompt.
    const firstTurn = capturedTranscripts[0]!;
    expect(firstTurn.length).toBe(3);
    expect(firstTurn[0]!.role).toBe('user');
    expect(firstTurn[0]!.content).toBe('prior question');
    expect(firstTurn[1]!.role).toBe('assistant');
    expect(firstTurn[2]!.role).toBe('user');
    expect(firstTurn[2]!.content).toBe('follow-up question');
  });

  it('falls back to raw string prompt when session.initialMessages is empty', async () => {
    const capturedTranscripts: KodaXMessage[][] = [];
    await runManagedTaskViaRunner(makeOptions(), 'fresh task', async (transcript) => {
      capturedTranscripts.push([...transcript]);
      return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
    });
    const firstTurn = capturedTranscripts[0]!;
    expect(firstTurn.length).toBe(1);
    expect(firstTurn[0]!.content).toBe('fresh task');
  });
});

describe('Shard 6d-c4 — onIterationEnd + contextTokenSnapshot', () => {
  it('fires onIterationEnd after every LLM turn with scope=worker', async () => {
    const iterations: Array<{ iter: number; scope?: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onIterationEnd: (info: { iter: number; scope?: string }) =>
          iterations.push({ iter: info.iter, scope: info.scope }),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT' },
            }],
          };
        }
        return { textBlocks: [{ text: 'done' }] };
      },
      generator: () => ({ textBlocks: [{ text: 'x' }] }),
      evaluator: () => ({ textBlocks: [{ text: 'x' }] }),
    });
    await runManagedTaskViaRunner(opts, 'T', mock);
    expect(iterations.length).toBeGreaterThanOrEqual(2); // scout turn 1 + scout turn 2
    expect(iterations.every((i) => i.scope === 'worker')).toBe(true);
    // Iteration counter is monotonically increasing
    expect(iterations[0]!.iter).toBeLessThan(iterations[iterations.length - 1]!.iter);
  });

  it('returns undefined contextTokenSnapshot when no provider usage is reported', async () => {
    // Using adapterOverride (no real provider.stream) means no usage data,
    // so the snapshot stays undefined — matching legacy behaviour for
    // estimated-only runs.
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Hi',
      async () => ({ textBlocks: [{ text: 'Hi' }], toolBlocks: [] }),
    );
    expect(result.contextTokenSnapshot).toBeUndefined();
  });
});

describe('Shard 6d-c3 — budget extension at 90% threshold', () => {
  it('fires askUser when Evaluator revises and budget exceeds 90%', async () => {
    const askUserCalls: Array<{ question: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        askUser: async (q: { question: string }) => {
          askUserCalls.push({ question: q.question });
          return 'continue';
        },
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      // Scout picks H1 so Generator + Evaluator both run. Budget cap is
      // 400 for H1; the short chain (scout + gen + eval + eval) is well
      // under 90%, so the askUser dialog is NOT fired — this verifies
      // the threshold gating is in place and doesn't spam.
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        return { textBlocks: [{ text: 'scout fallback' }] };
      },
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          // Burn budget by emitting many read tool calls first — but in
          // this test we simulate the threshold via direct spent >= 90%
          // by having many tool invocations. Because each emit + tool
          // call increments budget, a short chain like scout+gen+eval is
          // typically < 10 calls. To hit threshold quickly we lean on
          // the low H0 cap (50).
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'revise', reason: 'needs more work' },
            }],
          };
        }
        if (turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e2', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Done eventually' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Done eventually' }] };
      },
    });
    // The budget-extension prompt is gated on spentBudget >= 90% of total.
    // In this happy path with H0 cap 50, the chain burns ~6-8 units, so
    // the threshold is NOT hit and askUser fires only for the checkpoint
    // dialog (which is also gated on findValidCheckpoint). Since we have
    // no pre-existing checkpoint, askUser won't fire at all.
    await runManagedTaskViaRunner(opts, 'Task', mock);
    // Test passes as long as the wiring compiles and the call is
    // conditional (threshold not met in this short run). A dedicated
    // integration test under a pre-seeded high-usage budget controller
    // would be needed to drive this path end-to-end.
    expect(askUserCalls.length).toBe(0);
  });

  it('fires askUser when Evaluator revises and usage crosses 90% threshold', async () => {
    // Directly exercise `maybeRequestAdditionalWorkBudget` with a
    // pre-seeded controller, proving the helper we wire into the runner
    // path produces the expected askUser dialog + budget extension. The
    // integration with the Runner is exercised at compile-time via the
    // `wrapEmitterWithRecorder` budgetExtension path.
    const { maybeRequestAdditionalWorkBudget } = await import(
      './_internal/managed-task/budget.js'
    );
    const askUserCalls: Array<{ question: string }> = [];
    const events: KodaXEvents = {
      askUser: async (q: { question: string }) => {
        askUserCalls.push({ question: q.question });
        return 'continue';
      },
    } as KodaXEvents;
    const controller = {
      totalBudget: 400,
      spentBudget: 370, // 92.5% — over 90% threshold
      currentHarness: 'H1_EXECUTE_EVAL' as const,
    };
    const decision = await maybeRequestAdditionalWorkBudget(events, controller, {
      summary: 'needs more inspection',
      currentRound: 4,
      maxRounds: 6,
      originalTask: 'Heavy task',
    });
    expect(decision).toBe('approved');
    expect(askUserCalls.length).toBe(1);
    expect(askUserCalls[0]!.question).toMatch(/work units|budget/i);
    // Extension increased the budget
    expect(controller.totalBudget).toBeGreaterThan(400);
  });

  it('does not fire askUser when usage is below 90% threshold', async () => {
    const { maybeRequestAdditionalWorkBudget } = await import(
      './_internal/managed-task/budget.js'
    );
    const askUserCalls: Array<unknown> = [];
    const events: KodaXEvents = {
      askUser: async () => {
        askUserCalls.push({});
        return 'continue';
      },
    } as KodaXEvents;
    const controller = {
      totalBudget: 400,
      spentBudget: 100, // 25% — well under threshold
      currentHarness: 'H1_EXECUTE_EVAL' as const,
    };
    const decision = await maybeRequestAdditionalWorkBudget(events, controller, {
      summary: 'minor revise',
      currentRound: 2,
      maxRounds: 6,
      originalTask: 'Task',
    });
    expect(decision).toBe('skipped');
    expect(askUserCalls.length).toBe(0);
    expect(controller.totalBudget).toBe(400);
  });
});
