import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunnerToolCall, RunnerToolResult } from '@kodax-ai/agent';

import { estimateTokens } from '../tokenizer.js';
import { TOOL_OUTPUT_DIR_ENV } from '../tools/truncate.js';
import {
  createRunnerToolResultBatchTransform,
  estimateRunnerToolResultBatchTokens,
} from './runner-tool-result-batch.js';

describe('Runner tool-result batch capacity', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-runner-batch-'));
    process.env[TOOL_OUTPUT_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    delete process.env[TOOL_OUTPUT_DIR_ENV];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const transcript = [
    { role: 'system' as const, content: 'system' },
    { role: 'user' as const, content: 'task' },
    { role: 'assistant' as const, content: 'tool calls' },
  ];
  const baselineTokens = estimateTokens(transcript);

  function call(id: string, name: string): RunnerToolCall {
    return { id, name, input: {} };
  }

  function transformFor(
    contextWindow: number,
    currentTokens = 1_000,
    reservedResponseTokens = 4_000,
  ) {
    return createRunnerToolResultBatchTransform({
      ctx: { backups: new Map(), executionCwd: process.cwd() },
      contextWindow,
      reservedResponseTokens,
      contextTokenSnapshotRef: {
        current: {
          currentTokens,
          baselineEstimatedTokens: baselineTokens,
          source: 'api',
        },
      },
    });
  }

  it('spills a pathological result at the attention boundary even when the model window can hold it', async () => {
    const raw = Array.from({ length: 8_000 }, (_, index) => `complete-${index}`).join('\n');
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(64 * 1024);
    const results: RunnerToolResult[] = [{ content: raw, metadata: { handoffTarget: 'worker' } }];
    const transformed = await transformFor(128_000)({
      calls: [call('one', 'read')],
      results,
      transcript,
    });

    expect(transformed[0]!.content).toContain('KODAX_RESULT_INCOMPLETE');
    expect(transformed[0]!.metadata).toMatchObject({
      handoffTarget: 'worker',
      truncated: true,
      capacityFallback: true,
      outputPath: expect.any(String),
    });
    const [artifact] = await fs.readdir(tempDir);
    expect(artifact).toBeDefined();
    expect(await fs.readFile(path.join(tempDir, artifact!), 'utf8')).toBe(raw);
  });

  it('spills only after parallel results exceed the final aggregate token capacity', async () => {
    const calls = [call('first', 'read'), call('second', 'grep')];
    const results: RunnerToolResult[] = [
      { content: Array.from({ length: 1_800 }, (_, index) => `first-${index}`).join('\n') },
      { content: Array.from({ length: 1_800 }, (_, index) => `second-${index}`).join('\n'), metadata: { handoffTarget: 'worker' } },
    ];
    const rawTokens = estimateRunnerToolResultBatchTokens(calls, results);
    const availableTokens = Math.floor(rawTokens * 0.7);
    const currentTokens = 1_000;
    const reservedResponseTokens = 500;
    const margin = 2_048;
    const transformed = await transformFor(
      currentTokens + reservedResponseTokens + margin + availableTokens,
      currentTokens,
      reservedResponseTokens,
    )({ calls, results, transcript });

    const markers = transformed.filter((result) =>
      typeof result.content === 'string' && result.content.includes('KODAX_RESULT_INCOMPLETE'));
    expect(markers).toHaveLength(1);
    expect(markers[0]!.metadata).toMatchObject({
      truncated: true,
      capacityFallback: true,
      outputPath: expect.any(String),
    });
    expect(estimateRunnerToolResultBatchTokens(calls, transformed)).toBeLessThanOrEqual(availableTokens);
    expect(await fs.readdir(tempDir)).toHaveLength(1);
    expect(transformed[1]!.metadata?.handoffTarget).toBe('worker');
  });

  it('reuses structured artifact metadata when a guarded result needs a smaller preview later', async () => {
    const calls = [call('read-again', 'read')];
    const results: RunnerToolResult[] = [{
      content: Array.from({ length: 8_000 }, (_, index) => `evidence-${index}`).join('\n'),
    }];
    const currentTokens = 1_000;
    const reservedResponseTokens = 500;
    const firstAvailableTokens = 1_000;
    const first = await transformFor(
      currentTokens + reservedResponseTokens + 2_048 + firstAvailableTokens,
      currentTokens,
      reservedResponseTokens,
    )({ calls, results, transcript });
    const filesAfterFirstPass = await fs.readdir(tempDir);
    const firstOutputPath = first[0]!.metadata?.outputPath;

    const secondAvailableTokens = 400;
    const second = await transformFor(
      currentTokens + reservedResponseTokens + 2_048 + secondAvailableTokens,
      currentTokens,
      reservedResponseTokens,
    )({ calls, results: first, transcript });

    expect(typeof firstOutputPath).toBe('string');
    expect(second[0]!.content.length).toBeLessThan(first[0]!.content.length);
    expect((String(second[0]!.content).match(/KODAX_RESULT_INCOMPLETE/g) ?? []))
      .toHaveLength(1);
    expect(second[0]!.metadata?.outputPath).toBe(firstOutputPath);
    expect(await fs.readdir(tempDir)).toEqual(filesAfterFirstPass);
  });

  it('preserves non-string result content and metadata exactly', async () => {
    const multimodal: RunnerToolResult = {
      content: [
        { type: 'text', text: 'visual evidence' },
        { type: 'image', path: 'C:/tmp/evidence.png' },
      ],
      metadata: { handoffTarget: 'vision-worker' },
    };
    const transformed = await transformFor(128_000)({
      calls: [call('image', 'read')],
      results: [multimodal],
      transcript,
    });

    expect(transformed[0]).toBe(multimodal);
  });

  it('keeps a non-string result intact while spilling an over-capacity string sibling', async () => {
    const calls = [call('text', 'read'), call('image', 'read')];
    const multimodal: RunnerToolResult = {
      content: [
        { type: 'text', text: 'visual evidence' },
        { type: 'image', path: 'C:/tmp/evidence.png' },
      ],
      metadata: { handoffTarget: 'vision-worker' },
    };
    const currentTokens = 1_000;
    const reservedResponseTokens = 500;
    const availableTokens = 2_500;
    const transformed = await transformFor(
      currentTokens + reservedResponseTokens + 2_048 + availableTokens,
      currentTokens,
      reservedResponseTokens,
    )({
      calls,
      results: [
        { content: Array.from({ length: 4_000 }, (_, index) => `text-${index}`).join('\n') },
        multimodal,
      ],
      transcript,
    });

    expect(transformed[0]!.content).toContain('KODAX_RESULT_INCOMPLETE');
    expect(transformed[1]).toBe(multimodal);
    expect(estimateRunnerToolResultBatchTokens(calls, transformed))
      .toBeLessThanOrEqual(availableTokens);
  });

  it('admits an over-capacity non-string batch with capacity-debt metadata', async () => {
    const multimodal: RunnerToolResult = {
      content: [{ type: 'image', path: 'C:/tmp/large.png' }],
    };
    // FEATURE_296 (ADR-067): unspillable results no longer abort the run; the
    // pair commits with debt metadata and compaction owns the next request.
    const transformed = await transformFor(3_000, 1_000, 500)({
      calls: [call('image', 'read')],
      results: [multimodal],
      transcript,
    });
    expect(transformed).toHaveLength(1);
    expect(transformed[0]!.metadata).toMatchObject({ capacityDebt: true });
  });

  it('does not register the legacy per-result truncation guardrail in runner-driven', async () => {
    const source = await fs.readFile(new URL('./runner-driven.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('createToolResultTruncationGuardrail(');
    expect(source).toContain('toolResultBatchTransform');
  });
});
