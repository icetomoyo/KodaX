/**
 * Contract test for CAP-100 (FEATURE_296): capacity-debt tool-result admission.
 *
 * The final visible tool-result batch keeps its shaping owner (spill, marker,
 * attention bounds) but a physical-capacity shortfall no longer throws — it
 * returns marker-only entries plus a capacity-debt record. The tool_result
 * message therefore always commits after execution and the run continues to
 * the next iteration, where compaction can relieve the debt.
 *
 * Test obligations (FEATURE_296 T0):
 * - CAP-DEBT-001: an over-budget string batch admits with debt metadata, a
 *   preserved artifact pointer, and the run reaches a second LLM call
 * - CAP-DEBT-002: a non-string-only batch over budget admits with debt
 *   metadata instead of throwing
 * - CAP-DEBT-003: the envelope aggregate enforcer returns marker fragments
 *   plus one debt diagnostic instead of throwing
 * - CAP-DEBT-004: the batch guardrail choke point returns a structured debt
 *   record (requiredTokens/availableTokens) with marker-only entries
 *
 * Risk: HIGH (replaces the CAP-079/Issue 158 hard-gate default)
 *
 * Class: 1
 *
 * Verified location: coding/tools/tool-result-policy.ts:applyToolResultBatchGuardrail
 * and coding/task-engine/runner-tool-result-batch.ts:transformRunnerToolResultBatch,
 * driven end-to-end through Runner.run with the real batch transform.
 *
 * STATUS: ACTIVE since FEATURE_296 (ADR-067).
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAgent,
  Runner,
  setKodaXDiagnosticSink,
  type AgentMessage,
  type KodaXDiagnostic,
  type RunnableTool,
  type RunnerLlmResult,
  type RunnerToolResult,
} from '@kodax-ai/agent';

import type { KodaXToolExecutionContext } from '../../types.js';
import { TOOL_OUTPUT_DIR_ENV } from '../../tools/truncate.js';
import {
  applyToolResultBatchGuardrail,
  TOOL_RESULT_DEBT_DIAGNOSTIC_SOURCE,
} from '../../tools/tool-result-policy.js';
import type { ToolResultBudget } from '../../tools/tool-result-budget.js';
import { createEnvelopeAggregateBudgetEnforcer } from '../../tools/envelope-budget.js';
import { createRunnerToolResultBatchTransform } from '../../task-engine/runner-tool-result-batch.js';

// With a context window this small the safety-margin floor (2048) exceeds the
// whole window, so calculateMaxContextInputTokens returns 0 and every batch is
// over budget — exactly the population the Issue 158 hard gate aborted.
const DEBT_CONTEXT_WINDOW = 1_200;

function ctx(): KodaXToolExecutionContext {
  return { backups: new Map() };
}

function budget(aggregateInlineTokens: number): ToolResultBudget {
  return { aggregateInlineTokens };
}

describe('CAP-100: capacity-debt tool-result admission', () => {
  let tempDir = '';
  let diagnostics: KodaXDiagnostic[] = [];
  let restoreSink: (() => void) | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-capacity-debt-'));
    process.env[TOOL_OUTPUT_DIR_ENV] = tempDir;
    diagnostics = [];
    restoreSink = setKodaXDiagnosticSink((diagnostic) => {
      diagnostics.push(diagnostic);
    });
  });

  afterEach(async () => {
    restoreSink?.();
    delete process.env[TOOL_OUTPUT_DIR_ENV];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const debtDiagnostics = () =>
    diagnostics.filter(
      (d) => d.source === TOOL_RESULT_DEBT_DIAGNOSTIC_SOURCE && /debt/i.test(d.message),
    );

  it('CAP-DEBT-001: admits an over-budget string batch with debt metadata and reaches the next iteration', async () => {
    const hugeTool: RunnableTool = {
      name: 'read',
      description: 'Returns a large payload',
      input_schema: { type: 'object', properties: {}, required: [] },
      execute: async () => ({ content: 'debt evidence\n'.repeat(4_000) }),
    };
    const agent = createAgent({ name: 'debt-admission-agent', instructions: 'sys', tools: [hugeTool] });
    let turn = 0;
    const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
      turn += 1;
      if (turn === 1) {
        return {
          text: 'calling read',
          toolCalls: [{ id: 'call-1', name: 'read', input: {} }],
        };
      }
      return { text: 'final answer after debt', toolCalls: [] };
    });
    const observed: RunnerToolResult[] = [];
    const result = await Runner.run(agent, 'q', {
      llm,
      toolObserver: {
        onToolResult: (_call, toolResult) => {
          observed.push(toolResult);
        },
      },
      toolResultBatchTransform: createRunnerToolResultBatchTransform({
        ctx: ctx(),
        contextWindow: DEBT_CONTEXT_WINDOW,
        reservedResponseTokens: 0,
        contextTokenSnapshotRef: { current: undefined },
      }),
    });

    expect(result.output).toBe('final answer after debt');
    expect(llm).toHaveBeenCalledTimes(2);
    // Transcript: system, user, assistant(tool_use), user(tool_result), assistant
    const toolResultMessage = result.messages[3]!;
    expect(toolResultMessage.role).toBe('user');
    const toolResultBlock = (toolResultMessage.content as Array<{ type: string; content: unknown }>)[0]!;
    expect(toolResultBlock.type).toBe('tool_result');
    expect(String(toolResultBlock.content)).toContain('KODAX_RESULT_INCOMPLETE');
    expect(observed).toHaveLength(1);
    expect(observed[0]!.metadata).toMatchObject({
      truncated: true,
      capacityFallback: true,
      capacityDebt: true,
      outputPath: expect.any(String),
    });
    expect(await fs.readdir(tempDir)).toHaveLength(1);
    expect(debtDiagnostics()).toHaveLength(1);
  });

  it('CAP-DEBT-002: admits a non-string-only batch over budget with debt metadata', async () => {
    const imageTool: RunnableTool = {
      name: 'screenshot',
      description: 'Returns a structured image result',
      input_schema: { type: 'object', properties: {}, required: [] },
      execute: async () => ({
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
        ],
      }),
    };
    const agent = createAgent({ name: 'debt-image-agent', instructions: 'sys', tools: [imageTool] });
    let turn = 0;
    const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
      turn += 1;
      if (turn === 1) {
        return {
          text: 'calling screenshot',
          toolCalls: [{ id: 'call-2', name: 'screenshot', input: {} }],
        };
      }
      return { text: 'done', toolCalls: [] };
    });
    const observed: RunnerToolResult[] = [];
    const result = await Runner.run(agent, 'q', {
      llm,
      toolObserver: {
        onToolResult: (_call, toolResult) => {
          observed.push(toolResult);
        },
      },
      toolResultBatchTransform: createRunnerToolResultBatchTransform({
        ctx: ctx(),
        contextWindow: DEBT_CONTEXT_WINDOW,
        reservedResponseTokens: 0,
        contextTokenSnapshotRef: { current: undefined },
      }),
    });

    expect(result.output).toBe('done');
    expect(llm).toHaveBeenCalledTimes(2);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.metadata).toMatchObject({ capacityDebt: true });
  });

  it('CAP-DEBT-005: debt reaches the next iteration where the compaction hook relieves it', async () => {
    const hugeTool: RunnableTool = {
      name: 'read',
      description: 'Returns a large payload',
      input_schema: { type: 'object', properties: {}, required: [] },
      execute: async () => ({ content: 'debt evidence\n'.repeat(4_000) }),
    };
    const agent = createAgent({ name: 'debt-compaction-agent', instructions: 'sys', tools: [hugeTool] });
    let turn = 0;
    const seenTranscripts: unknown[][] = [];
    const llm = vi.fn(async (messages): Promise<RunnerLlmResult> => {
      seenTranscripts.push([...messages]);
      turn += 1;
      if (turn === 1) {
        return {
          text: 'calling read',
          toolCalls: [{ id: 'call-5', name: 'read', input: {} }],
        };
      }
      return { text: 'resumed after compaction', toolCalls: [] };
    });
    // Stub of the managed compaction hook: once the debt round is in the
    // transcript, compact away the original oversized user message.
    const compactionHook = vi.fn(async (messages: readonly AgentMessage[]) => {
      const hasDebtRound = messages.some(
        (message) => typeof message.content !== 'string'
          && JSON.stringify(message.content).includes('KODAX_RESULT_INCOMPLETE'),
      );
      if (!hasDebtRound) return undefined;
      return messages.filter(
        (message) => !(message.role === 'user' && message.content === 'q'),
      );
    });
    const result = await Runner.run(agent, 'q', {
      llm,
      compactionHook,
      toolResultBatchTransform: createRunnerToolResultBatchTransform({
        ctx: ctx(),
        contextWindow: DEBT_CONTEXT_WINDOW,
        reservedResponseTokens: 0,
        contextTokenSnapshotRef: { current: undefined },
      }),
    });

    // The debt round committed, the next iteration's hook relieved it, and
    // the second LLM call saw the compacted transcript without the original
    // oversized user message.
    expect(result.output).toBe('resumed after compaction');
    expect(compactionHook).toHaveBeenCalled();
    const secondTranscript = seenTranscripts[1]! as Array<{ role: string; content: unknown }>;
    expect(
      secondTranscript.some((message) => message.role === 'user' && message.content === 'q'),
    ).toBe(false);
    expect(
      secondTranscript.some((message) => JSON.stringify(message.content).includes('KODAX_RESULT_INCOMPLETE')),
    ).toBe(true);
  });

  it('CAP-DEBT-003: the envelope enforcer returns marker fragments with one debt diagnostic', async () => {
    const enforce = createEnvelopeAggregateBudgetEnforcer(ctx(), () => budget(1));

    const result = await enforce(['X '.repeat(400)]);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain('KODAX_RESULT_INCOMPLETE');
    expect(debtDiagnostics()).toHaveLength(1);
  });

  it('CAP-DEBT-004: the batch guardrail returns marker-only entries plus a structured debt record', async () => {
    const guarded = await applyToolResultBatchGuardrail(
      [{ id: 'call-3', toolName: 'read', content: 'raw evidence '.repeat(2_000) }],
      ctx(),
      budget(1),
    );

    expect(guarded.entries).toHaveLength(1);
    expect(guarded.entries[0]!.content).toContain('KODAX_RESULT_INCOMPLETE');
    expect(guarded.capacityDebt).toBeDefined();
    expect(guarded.capacityDebt!.requiredTokens).toBeGreaterThan(
      guarded.capacityDebt!.availableTokens,
    );
    expect(debtDiagnostics()).toHaveLength(1);
  });
});
