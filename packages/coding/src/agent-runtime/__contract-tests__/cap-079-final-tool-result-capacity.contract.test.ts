import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KodaXToolUseBlock } from '@kodax-ai/llm';

import type { KodaXEvents, KodaXToolExecutionContext } from '../../types.js';
import { countTokens, estimateTokens } from '../../tokenizer.js';
import { TOOL_OUTPUT_DIR_ENV } from '../../tools/truncate.js';
import type { ToolResultBudget } from '../../tools/tool-result-budget.js';
import { applyPostToolProcessing, runToolDispatch } from '../tool-dispatch.js';
import { buildRuntimeSessionState } from '../runtime-session-state.js';

function tool(id: string, name: string, input: Record<string, unknown> = {}): KodaXToolUseBlock {
  return { id, name, type: 'tool_use', input } as KodaXToolUseBlock;
}

function budget(aggregateInlineTokens: number): ToolResultBudget {
  return { aggregateInlineTokens };
}

function ctx(): KodaXToolExecutionContext {
  return { backups: new Map() };
}

describe('CAP-079: final visible tool-result batch owns capacity', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-final-batch-'));
    process.env[TOOL_OUTPUT_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    delete process.env[TOOL_OUTPUT_DIR_ENV];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('does not let a discarded invisible result consume or spill the visible batch', async () => {
    const hidden = 'hidden evidence\n'.repeat(20_000);
    const visible = 'visible evidence\n'.repeat(200);
    const toolBlocks = [
      tool('hidden', 'emit_managed_protocol'),
      tool('visible', 'read'),
    ];
    const events: KodaXEvents = {
      beforeToolExecute: vi.fn(async (_name, _input, hint) =>
        hint?.toolId === 'hidden' ? hidden : visible),
    };
    const executionContext = ctx();
    const toolResultBudget = budget(countTokens(visible) + 8);
    const runtimeSessionState = buildRuntimeSessionState({
      activeTools: ['read'],
      modelSelection: {},
    });
    const resultMap = await runToolDispatch({
      toolBlocks,
      events,
      ctx: executionContext,
      runtimeSessionState,
      activeToolNames: ['read'],
      abortSignal: undefined,
    });

    const processed = await applyPostToolProcessing({
      toolBlocks,
      resultMap,
      events,
      emitActiveExtensionEvent: vi.fn().mockResolvedValue(undefined),
      ctx: executionContext,
      runtimeSessionState,
      toolResultBudget,
    });

    expect(resultMap.get('hidden')).toBe(hidden);
    expect(processed.toolResults).toHaveLength(1);
    expect(processed.toolResults[0]!.content).toBe(visible);
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it('keeps a structured artifact pointer on a visible result spilled by final capacity admission', async () => {
    const visible = 'recoverable evidence\n'.repeat(4_000);
    const toolBlocks = [tool('visible', 'read')];
    const executionContext = ctx();
    const runtimeSessionState = buildRuntimeSessionState({
      activeTools: ['read'],
      modelSelection: {},
    });

    const processed = await applyPostToolProcessing({
      toolBlocks,
      resultMap: new Map([['visible', visible]]),
      events: {},
      emitActiveExtensionEvent: vi.fn().mockResolvedValue(undefined),
      ctx: executionContext,
      runtimeSessionState,
      toolResultBudget: budget(500),
    });

    expect(processed.toolResults[0]!.content).toContain('KODAX_RESULT_INCOMPLETE');
    expect(processed.toolResults[0]!.metadata).toMatchObject({
      truncated: true,
      capacityFallback: true,
      outputPath: expect.any(String),
    });
    expect(await fs.readdir(tempDir)).toHaveLength(1);
  });

  it('does not nest a tool-owned recovery artifact during final batch admission', async () => {
    const outputPath = path.join(tempDir, 'bash-recovery-manifest.txt');
    await fs.writeFile(outputPath, 'canonical recovery manifest', 'utf8');
    const content = [
      'Command: test',
      `stdout recovery: ${path.join(tempDir, 'stdout.txt')}`,
      `stderr recovery: ${path.join(tempDir, 'stderr.txt')}`,
      `diagnostics: ${'already persisted detail '.repeat(200)}`,
      `[KODAX_RESULT_INCOMPLETE. Full output saved to: ${outputPath}.]`,
    ].join('\n');
    const toolBlocks = [tool('bash-1', 'bash')];
    const runtimeSessionState = buildRuntimeSessionState({
      activeTools: ['bash'],
      modelSelection: {},
    });

    const processed = await applyPostToolProcessing({
      toolBlocks,
      resultMap: new Map([['bash-1', content]]),
      events: {},
      emitActiveExtensionEvent: vi.fn().mockResolvedValue(undefined),
      ctx: ctx(),
      runtimeSessionState,
      toolResultBudget: budget(150),
      toolResultArtifactPaths: new Map([['bash-1', outputPath]]),
    });

    expect(processed.toolResults[0]!.metadata?.outputPath).toBe(outputPath);
    expect(await fs.readdir(tempDir)).toEqual(['bash-recovery-manifest.txt']);
  });

  it('spills a result that fits alone when its same-request edit recovery would overflow', async () => {
    const rawResult = `[Tool Error] edit: EDIT_TOO_LARGE: ${'oversized edit evidence '.repeat(2_000)}`;
    const resultOnlyTokens = 4 + countTokens(rawResult) + 4;
    const toolBlocks = [tool('edit-1', 'edit', { path: path.join(tempDir, 'target.ts') })];
    const runtimeSessionState = buildRuntimeSessionState({
      activeTools: ['edit'],
      modelSelection: {},
    });

    const processed = await applyPostToolProcessing({
      toolBlocks,
      resultMap: new Map([['edit-1', rawResult]]),
      events: {},
      emitActiveExtensionEvent: vi.fn().mockResolvedValue(undefined),
      ctx: ctx(),
      runtimeSessionState,
      toolResultBudget: budget(resultOnlyTokens + 1),
    });

    const recoveryTokens = estimateTokens([{
      role: 'user',
      content: processed.editRecoveryMessages.join('\n\n'),
      _synthetic: true,
    }]);
    const admittedResultTokens = 4 + processed.toolResults.reduce(
      (total, result) => total + countTokens(result.content as string) + 4,
      0,
    );
    expect(processed.toolResults[0]!.content).toContain('KODAX_RESULT_INCOMPLETE');
    expect(admittedResultTokens + recoveryTokens).toBeLessThanOrEqual(resultOnlyTokens + 1);
  });

  it('admits an irreducible recovery payload with capacity debt even when the raw result fits by itself', async () => {
    const rawResult = '[Tool Error] edit: EDIT_TOO_LARGE: x';
    const resultOnlyTokens = 4 + countTokens(rawResult) + 4;
    const toolBlocks = [tool('edit-1', 'edit', { path: path.join(tempDir, 'target.ts') })];
    const runtimeSessionState = buildRuntimeSessionState({
      activeTools: ['edit'],
      modelSelection: {},
    });

    const processed = await applyPostToolProcessing({
      toolBlocks,
      resultMap: new Map([['edit-1', rawResult]]),
      events: {},
      emitActiveExtensionEvent: vi.fn().mockResolvedValue(undefined),
      ctx: ctx(),
      runtimeSessionState,
      toolResultBudget: budget(resultOnlyTokens + 1),
    });

    // FEATURE_296 (ADR-067): an irreducible marker no longer fails the batch;
    // the pair commits with debt metadata and compaction owns recovery.
    expect(processed.toolResults).toHaveLength(1);
    expect(processed.toolResults[0]!.content).toContain('KODAX_RESULT_INCOMPLETE');
    expect(processed.toolResults[0]!.content).toContain('Full output saved to:');
    expect(processed.toolResults[0]!.metadata).toMatchObject({
      capacityDebt: true,
      outputPath: expect.any(String),
    });
  });

  it('reserves the active provider output budget and a physical-token safety margin', async () => {
    const source = await fs.readFile(new URL('../run-substrate.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const toolResultCurrentTokens =');
    const end = source.indexOf('resultMap = await runToolDispatch', start);
    const capacitySetup = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(capacitySetup.match(/resolveContextTokenCount\(/g)).toHaveLength(1);
    expect(capacitySetup).toContain('streamProvider.getEffectiveMaxOutputTokens(');
    expect(capacitySetup).toContain('buildToolResultBudgetFromUsage({');
    expect(capacitySetup).not.toContain('Math.ceil(');
    expect(capacitySetup).not.toContain('2_048');
    expect(capacitySetup).not.toContain('cachedReadTokens');
  });
});
