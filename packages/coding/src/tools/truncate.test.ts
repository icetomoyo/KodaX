import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { setAgentConfigHome } from '@kodax-ai/agent';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatSize,
  formatDiffPreview,
  persistToolOutput,
  TOOL_OUTPUT_DIR_ENV,
  trimBufferStartToUtf8Boundary,
  truncateHead,
  truncateLine,
  truncateMiddle,
  truncateTail,
} from './truncate.js';

describe('truncate helpers', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    delete process.env[TOOL_OUTPUT_DIR_ENV];
    setAgentConfigHome(undefined);
    await Promise.all(
      tempPaths.splice(0).map(async (entry) => {
        await fs.rm(entry, { recursive: true, force: true });
      }),
    );
  });

  it('truncates head output by line count', () => {
    const result = truncateHead('a\nb\nc\nd', { maxLines: 2, maxBytes: 100 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('lines');
    expect(result.content).toBe('a\nb');
  });

  it('truncates tail output and keeps the end', () => {
    const result = truncateTail('a\nb\nc\nd', { maxLines: 2, maxBytes: 100 });
    expect(result.truncated).toBe(true);
    expect(result.content).toBe('c\nd');
  });

  it('truncates tail on a UTF-8 boundary when a single line exceeds the byte limit', () => {
    const result = truncateTail(`前缀${'你'.repeat(8)}`, { maxLines: 5, maxBytes: 10 });
    expect(result.truncated).toBe(true);
    expect(result.lastLinePartial).toBe(true);
    expect(result.content).not.toContain('\uFFFD');
  });

  it('reports when the first line exceeds the head byte limit', () => {
    const result = truncateHead(`你${'好'.repeat(40)}`, { maxLines: 10, maxBytes: 8 });
    expect(result.truncated).toBe(true);
    expect(result.firstLineExceedsLimit).toBe(true);
    expect(result.content).toBe('');
  });

  it('truncates long single lines', () => {
    const line = 'x'.repeat(40);
    const result = truncateLine(line, 10);
    expect(result.wasTruncated).toBe(true);
    expect(result.text).toContain('[truncated]');
  });

  it('keeps both ends within the middle-preview line and byte limits', () => {
    expect(truncateMiddle('a\nb\nc\nd\ne', { maxLines: 3, maxBytes: 100 }).content).toBe('a\n[...]\ne');
    expect(truncateMiddle('complete', { maxLines: 3, maxBytes: 100 }).content).toBe('complete');
    const tiny = truncateMiddle('long single line', { maxBytes: 3 });
    expect(tiny.content).toBe('');
    expect(tiny.outputBytes).toBe(0);
  });

  it('trims buffer starts to a UTF-8 boundary', () => {
    const buffer = Buffer.from('A你B', 'utf-8');
    const trimmed = trimBufferStartToUtf8Boundary(buffer, 2);
    expect(trimmed.toString('utf-8')).toBe('B');
  });

  it('keeps the complete diff even when legacy preview limits are supplied', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-truncate-'));
    tempPaths.push(tempRoot);
    const invalidOutputDir = path.join(tempRoot, 'not-a-dir');
    await fs.writeFile(invalidOutputDir, 'occupied', 'utf-8');
    process.env[TOOL_OUTPUT_DIR_ENV] = invalidOutputDir;

    const preview = await formatDiffPreview({
      diff: Array.from({ length: 500 }, (_, index) => `+ line-${index}`).join('\n'),
      toolName: 'write',
      filePath: 'sample.ts',
      ctx: { backups: new Map(), executionCwd: tempRoot },
      maxLines: 10,
      maxBytes: 256,
    });

    expect(preview).toContain('+ line-0');
    expect(preview).toContain('+ line-499');
    expect(preview).not.toContain('Diff preview truncated');
    expect(await fs.readdir(tempRoot)).toEqual(['not-a-dir']);
  });

  it('does not age-delete recovery artifacts that may still be referenced by a resumable session', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-tool-output-retention-'));
    tempPaths.push(outputDir);
    process.env[TOOL_OUTPUT_DIR_ENV] = outputDir;
    const referencedArtifact = path.join(outputDir, 'referenced-by-live-session.txt');
    await fs.writeFile(referencedArtifact, 'canonical evidence', 'utf-8');
    await fs.utimes(referencedArtifact, new Date(0), new Date(0));
    await persistToolOutput('bash', 'new evidence', { executionCwd: outputDir });
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect(fs.readFile(referencedArtifact, 'utf-8')).resolves.toBe('canonical evidence');
  });

  it('does not persist through a tool-results link into Runtime', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-tool-output-boundary-'));
    tempPaths.push(root);
    const agentHome = path.join(root, 'agent-home');
    const runtimeDirectory = path.join(agentHome, 'runtime');
    const outputLink = path.join(agentHome, 'tool-results');
    await fs.mkdir(runtimeDirectory, { recursive: true });
    await fs.symlink(
      runtimeDirectory,
      outputLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    setAgentConfigHome(agentHome);
    process.env[TOOL_OUTPUT_DIR_ENV] = outputLink;

    await expect(persistToolOutput('read', 'must-not-enter-runtime'))
      .rejects.toThrow('protected KodaX state');
    const runtimeEntries = await fs.readdir(runtimeDirectory);
    expect(runtimeEntries.every((entry) => entry.startsWith('test-filesystem-effects-'))).toBe(true);
  });

  it('formats byte sizes', () => {
    expect(formatSize(512)).toBe('512B');
    expect(formatSize(2048)).toBe('2.0KB');
  });
});
