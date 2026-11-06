import { describe, expect, it } from 'vitest';
import { exceedsContextCapacity, reclaimReservedResponseTokens } from '@kodax-ai/agent';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { toolRead } from './read.js';
import { estimateTokens } from '../tokenizer.js';
import { createRunnerToolResultBatchTransform, estimateRunnerToolResultBatchTokens,
  resolveRunnerToolResultBudget } from '../task-engine/runner-tool-result-batch.js';
import type {
  RuntimeContextBudgetSnapshot,
  RuntimeContextPressure,
} from '../agent-runtime/context-budget.js';

import {
  buildToolResultBudget,
  buildToolResultBudgetFromUsage,
  clampToolResultPolicyToBudget,
} from './tool-result-budget.js';

function snapshot(input: {
  contextWindow: number;
  availableTokens: number;
  usedRatio: number;
  pressure: RuntimeContextPressure;
  smallWindow: boolean;
}): RuntimeContextBudgetSnapshot {
  return {
    ...input,
    profile: 'balanced',
    tokenBreakdown: {
      systemPrompt: 0,
      toolSchemas: 0,
      skillCatalog: 0,
      mcpCatalog: 0,
      transcript: 0,
      pendingInput: 0,
      recentToolResults: 0,
      reservedResponse: 0,
      total: input.contextWindow - input.availableTokens,
    },
    usedTokens: input.contextWindow - input.availableTokens,
    toolSchemaRatio: 0,
    recommendations: [],
    createdAt: '2026-07-15T00:00:00.000Z',
  };
}

describe('tool result budget', () => {
  it.each([8192, 16384, 32768, 65536, 98304])('keeps reading at a %i context window when generation can reclaim a large output reserve', async contextWindow => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-read-reserve-'));
    try {
      const filePath = path.join(directory, 'evidence.txt');
      await fs.writeFile(filePath, 'Evidence: the critical exception is in section nine.');
      const transcript = [{ role: 'user' as const, content: 'Read the evidence.' }];
      const ctx = { backups: new Map(), executionCwd: directory, canReadPagedContent: true };
      const options = { ctx, contextWindow, reservedResponseTokens: contextWindow,
        contextTokenSnapshotRef: { current: { currentTokens: 3000,
          baselineEstimatedTokens: estimateTokens(transcript), source: 'api' as const } } };
      const budget = resolveRunnerToolResultBudget(transcript, options);
      const page = await toolRead({ path: filePath }, {
        ...ctx, toolResultCapacityTokens: budget.aggregateInlineTokens,
      });
      expect(page).toContain('critical exception');
      expect(page).not.toContain('[Tool Error]');
      const calls = [{ id: 'read-evidence', name: 'read', input: { path: filePath } }];
      const admitted = await createRunnerToolResultBatchTransform(options)({
        calls, results: [{ content: page }], transcript,
      });
      expect(admitted[0]!.content).toBe(page);
      expect(admitted[0]!.metadata?.capacityDebt).not.toBe(true);
      const currentTokens = 3000 + estimateRunnerToolResultBatchTokens(calls, admitted);
      const reservedResponseTokens = reclaimReservedResponseTokens({
        contextWindow, currentTokens, reservedResponseTokens: contextWindow,
      });
      expect(exceedsContextCapacity({ contextWindow, currentTokens, reservedResponseTokens })).toBe(false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it('preserves the public snapshot-budget compatibility API', () => {
    const budget = buildToolResultBudget(snapshot({
      contextWindow: 128_000,
      availableTokens: 64_000,
      usedRatio: 0.5,
      pressure: 'low',
      smallWindow: false,
    }));

    expect(budget.aggregateInlineTokens).toBe(64_000);
    expect(budget.aggregateInlineBytes).toBe(192 * 1024);
    expect(budget.reason).toBe('large_window');
  });

  it('preserves the opt-in legacy policy clamp without using it internally', () => {
    const budget = buildToolResultBudget(snapshot({
      contextWindow: 16_000,
      availableTokens: 1_600,
      usedRatio: 0.9,
      pressure: 'critical',
      smallWindow: true,
    }));
    const clamped = clampToolResultPolicyToBudget({
      maxLines: 1_200,
      maxBytes: 40 * 1024,
      direction: 'head',
      spillToFile: true,
    }, budget);

    expect(clamped.maxBytes).toBe(4 * 1024);
    expect(clamped.maxLines).toBe(120);
  });

  it('honors the safety floor when lightweight usage leaves no admissible batch space', () => {
    const budget = buildToolResultBudgetFromUsage({
      contextWindow: 16_000,
      currentTokens: 14_000,
    });

    expect(budget.aggregateInlineTokens).toBe(0);
  });

  it('does not invent page capacity when even the reclaimed output floor cannot fit', () => {
    expect(buildToolResultBudgetFromUsage({ contextWindow: 8192, currentTokens: 6000,
      reservedResponseTokens: 8192 }).aggregateInlineTokens).toBe(0);
  });

  it('subtracts response and canonical safety reserves from the final batch capacity', () => {
    const budget = buildToolResultBudgetFromUsage({
      contextWindow: 128_000,
      currentTokens: 20_000,
      reservedResponseTokens: 8_000,
    });

    expect(budget.aggregateInlineTokens).toBe(96_504);
    expect(exceedsContextCapacity({
      contextWindow: 128_000,
      currentTokens: 20_000 + budget.aggregateInlineTokens,
      reservedResponseTokens: 8_000,
    })).toBe(false);
    expect(exceedsContextCapacity({
      contextWindow: 128_000,
      currentTokens: 20_001 + budget.aggregateInlineTokens,
      reservedResponseTokens: 8_000,
    })).toBe(true);
  });

  it('keeps fixed-point token capacity alongside compatibility metadata', () => {
    const budget = buildToolResultBudgetFromUsage({
      contextWindow: 128_000,
      currentTokens: 20_000,
      reservedResponseTokens: 8_000,
    });

    expect(budget.aggregateInlineTokens).toBe(96_504);
    expect(budget.contextWindow).toBe(128_000);
    expect(budget.pressure).toBe('low');
  });
});
