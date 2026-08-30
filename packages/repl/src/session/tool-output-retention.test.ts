import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionManager } from './public-api.js';

describe('session tool-output retention', () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.KODAX_TOOL_OUTPUT_DIR;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('removes stale orphan artifacts but preserves references in resumable JSONL', async () => {
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

    vi.useFakeTimers();
    const timersBefore = vi.getTimerCount();
    createSessionManager({ sessionsDir });
    expect(vi.getTimerCount()).toBe(timersBefore + 1);
    await vi.advanceTimersByTimeAsync(30_000);

    await vi.waitFor(async () => {
      await expect(fs.stat(referenced)).resolves.toBeDefined();
      await expect(fs.stat(referencedStream)).resolves.toBeDefined();
      await expect(fs.stat(orphaned)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    vi.useRealTimers();
  });
});
