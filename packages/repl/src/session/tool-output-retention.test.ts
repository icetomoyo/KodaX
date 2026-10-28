import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as coding from '@kodax-ai/coding';
import { __resetGcCooldownForTests } from '../../../coding/src/tools/tool-output-gc.js';

import { createSessionManager } from './public-api.js';

describe('session tool-output retention', () => {
  let root: string | undefined;

  beforeEach(() => __resetGcCooldownForTests());

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.KODAX_TOOL_OUTPUT_DIR;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('allows explicit cleanup with a complete reference set while preserving recovery streams', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-retention-'));
    const sessionsDir = path.join(root, 'sessions');
    const outputDir = path.join(root, 'tool-results');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    const referenced = path.join(outputDir, 'run-bash-recovery-manifest-abc.txt');
    const referencedStream = path.join(outputDir, 'referenced-stream.txt');
    const orphaned = path.join(outputDir, 'orphaned-output.txt');
    await fs.writeFile(referenced, `stdout recovery: ${referencedStream}`, 'utf-8');
    await fs.writeFile(referencedStream, 'needed', 'utf-8');
    await fs.writeFile(orphaned, 'dead', 'utf-8');
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(referenced, stale, stale);
    await fs.utimes(referencedStream, stale, stale);
    await fs.utimes(orphaned, stale, stale);
    await fs.writeFile(
      path.join(sessionsDir, 'resume.jsonl'),
      `${JSON.stringify({ metadata: { outputPath: referenced } })}\n`,
      'utf-8',
    );
    process.env.KODAX_TOOL_OUTPUT_DIR = outputDir;

    await coding.cleanupUnreferencedToolOutputs(outputDir, new Set([referenced, referencedStream]));
    await expect(fs.stat(referenced)).resolves.toBeDefined();
    await expect(fs.stat(referencedStream)).resolves.toBeDefined();
    await expect(fs.stat(orphaned)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not delete an old result still referenced by a different SDK sessions directory', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-shared-output-retention-'));
    const outputDir = path.join(root, 'tool-results');
    const sessionsA = path.join(root, 'sessions-a');
    const sessionsB = path.join(root, 'sessions-b');
    await Promise.all([outputDir, sessionsA, sessionsB].map(dir => fs.mkdir(dir, { recursive: true })));
    const original = path.join(outputDir, 'live-mcp-result.txt');
    await fs.writeFile(original, 'MCP_TAIL_EVIDENCE');
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(original, stale, stale);
    await fs.writeFile(path.join(sessionsB, 'live.jsonl'), `${JSON.stringify({ metadata: { outputPath: original } })}\n`);
    process.env.KODAX_TOOL_OUTPUT_DIR = outputDir;
    vi.useFakeTimers();
    const housekeeping = vi.spyOn(coding, 'maybeRunReferenceAwareToolOutputGc');
    createSessionManager({ sessionsDir: sessionsA });
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all(housekeeping.mock.results.map(result => result.value as Promise<unknown>));
    await expect(fs.readFile(original, 'utf8')).resolves.toBe('MCP_TAIL_EVIDENCE');
  });
});
