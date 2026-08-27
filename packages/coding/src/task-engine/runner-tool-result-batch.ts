import type {
  RunnerToolCall,
  RunnerToolResult,
  RunnerToolResultBatch,
  RunnerToolResultBatchTransform,
} from '@kodax-ai/agent';
import type { KodaXMessage, KodaXToolResultBlock } from '@kodax-ai/llm';

import { estimateTokens } from '../tokenizer.js';
import { resolveContextTokenCount } from '../token-accounting.js';
import type { KodaXToolExecutionContext } from '../types.js';
import type { ContextTokenSnapshotRef } from './_internal/managed-task/compaction.js';
import {
  buildToolResultBudgetFromUsage,
  type ToolResultBudget,
} from '../tools/tool-result-budget.js';
import {
  applyToolResultBatchGuardrail,
  emitCapacityDebtDiagnostic,
  type ToolResultBatchEntry,
} from '../tools/tool-result-policy.js';

export interface RunnerToolResultBatchTransformOptions {
  readonly ctx: KodaXToolExecutionContext;
  readonly contextWindow: number;
  readonly reservedResponseTokens: number;
  readonly contextTokenSnapshotRef: ContextTokenSnapshotRef;
  readonly onCapacityFallback?: (call: RunnerToolCall) => void;
}

export function createRunnerToolResultBatchTransform(
  options: RunnerToolResultBatchTransformOptions,
): RunnerToolResultBatchTransform {
  return (batch) => transformRunnerToolResultBatch(batch, options);
}

async function transformRunnerToolResultBatch(
  batch: RunnerToolResultBatch,
  options: RunnerToolResultBatchTransformOptions,
): Promise<readonly RunnerToolResult[]> {
  const budget = resolveRunnerToolResultBudget(batch.transcript, options);
  const rawTokens = estimateRunnerToolResultBatchTokens(batch.calls, batch.results);
  const stringEntries = collectStringEntries(batch);
  if (stringEntries.length === 0) {
    if (rawTokens > budget.aggregateInlineTokens) {
      // FEATURE_296: unspillable non-string results admit with debt instead of
      // aborting; the pair commits and compaction owns the next request.
      emitCapacityDebtDiagnostic(rawTokens, budget.aggregateInlineTokens);
      return stampCapacityDebt(batch.results);
    }
    return batch.results;
  }
  const nonStringTokens = estimateNonStringResultTokens(batch.calls, batch.results);
  const stringBudgetTokens = Math.max(0, budget.aggregateInlineTokens - nonStringTokens);
  const guarded = await applyToolResultBatchGuardrail(
    stringEntries,
    options.ctx,
    narrowBudgetToStrings(budget, stringBudgetTokens),
  );
  const transformed = mergeGuardedStringResults(batch, guarded.entries, options);
  const finalTokens = estimateRunnerToolResultBatchTokens(batch.calls, transformed);
  if (finalTokens > budget.aggregateInlineTokens && !guarded.capacityDebt) {
    // The transform's estimate can disagree slightly with the guardrail's
    // per-entry count; either way the shortfall is debt, not a failure.
    emitCapacityDebtDiagnostic(finalTokens, budget.aggregateInlineTokens);
  }
  // Debt is authoritative from the choke point: even when the transform's own
  // recount happens to fit, a guardrail debt keeps the batch marked.
  return guarded.capacityDebt ? stampCapacityDebt(transformed) : transformed;
}

function stampCapacityDebt(
  results: readonly RunnerToolResult[],
): readonly RunnerToolResult[] {
  return results.map((result) => ({
    ...result,
    metadata: {
      ...(result.metadata ?? {}),
      capacityDebt: true,
    },
  }));
}

export function resolveRunnerToolResultBudget(
  transcript: readonly KodaXMessage[],
  options: RunnerToolResultBatchTransformOptions,
): ToolResultBudget {
  const currentTokens = resolveContextTokenCount(
    [...transcript],
    options.contextTokenSnapshotRef.current,
  );
  return buildToolResultBudgetFromUsage({
    contextWindow: options.contextWindow,
    currentTokens,
    reservedResponseTokens: options.reservedResponseTokens,
  });
}

function collectStringEntries(batch: RunnerToolResultBatch): ToolResultBatchEntry[] {
  return batch.results.flatMap((result, index) => {
    if (typeof result.content !== 'string') return [];
    const outputPath = result.metadata?.outputPath;
    return [{
      id: batch.calls[index]!.id,
      toolName: batch.calls[index]!.name,
      content: result.content,
      ...(typeof outputPath === 'string' && outputPath.length > 0 ? { outputPath } : {}),
    }];
  });
}

function narrowBudgetToStrings(
  budget: ToolResultBudget,
  aggregateInlineTokens: number,
): ToolResultBudget {
  return { ...budget, aggregateInlineTokens };
}

function mergeGuardedStringResults(
  batch: RunnerToolResultBatch,
  guardedEntries: readonly ToolResultBatchEntry[],
  options: RunnerToolResultBatchTransformOptions,
): RunnerToolResult[] {
  const guardedById = new Map(guardedEntries.map((entry) => [entry.id, entry]));
  return batch.results.map((result, index): RunnerToolResult => {
    if (typeof result.content !== 'string') return result;
    const guarded = guardedById.get(batch.calls[index]!.id);
    const content = guarded?.content ?? result.content;
    if (content === result.content) return result;
    options.onCapacityFallback?.(batch.calls[index]!);
    return {
      ...result,
      content,
      metadata: {
        ...(result.metadata ?? {}),
        truncated: true,
        capacityFallback: true,
        ...(guarded?.outputPath ? { outputPath: guarded.outputPath } : {}),
      },
    };
  });
}

export function estimateRunnerToolResultBatchTokens(
  calls: readonly RunnerToolCall[],
  results: readonly RunnerToolResult[],
): number {
  return estimateTokens([buildToolResultTokenMessage(calls, results)]);
}

function estimateNonStringResultTokens(
  calls: readonly RunnerToolCall[],
  results: readonly RunnerToolResult[],
): number {
  const blocks = buildToolResultBlocks(calls, results)
    .filter((_, index) => typeof results[index]!.content !== 'string');
  if (blocks.length === 0) return 0;
  return estimateTokens([{ role: 'user', content: blocks }]) - 4;
}

function buildToolResultTokenMessage(
  calls: readonly RunnerToolCall[],
  results: readonly RunnerToolResult[],
): KodaXMessage {
  return { role: 'user', content: buildToolResultBlocks(calls, results) };
}

function buildToolResultBlocks(
  calls: readonly RunnerToolCall[],
  results: readonly RunnerToolResult[],
): KodaXToolResultBlock[] {
  return calls.map((call, index) => ({
    type: 'tool_result',
    tool_use_id: call.id,
    content: results[index]!.content,
    ...(results[index]!.isError === true ? { is_error: true } : {}),
  }));
}
