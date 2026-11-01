/**
 * FEATURE_121 v0.7.40 — tool-output spillover GC tests.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { setAgentConfigHome } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TOOL_OUTPUT_TTL_MS,
  GC_COOLDOWN_MS,
  __resetGcCooldownForTests,
  cleanupExpiredToolOutputs,
  cleanupUnreferencedToolOutputs,
  maybeRunToolOutputGc,
  inspectToolOutputStorage,
} from './tool-output-gc.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'kodax-gc-test-'));
}

it('reports storage capacity without deleting recovery evidence and distinguishes incomplete inspection', async () => {
  const root = await makeTempDir();
  try {
    await fs.writeFile(path.join(root, 'retained.txt'), 'evidence');
    await fs.mkdir(path.join(root, 'other-namespace'));
    expect(await inspectToolOutputStorage(root)).toMatchObject({ files: 1, bytes: 8, directories: 1, failed: 0, status: 'complete' });
    expect(await fs.readFile(path.join(root, 'retained.txt'), 'utf8')).toBe('evidence');
    expect(await inspectToolOutputStorage(path.join(root, 'missing'))).toMatchObject({ status: 'missing', failed: 0 });
    expect(await inspectToolOutputStorage(path.join(root, 'retained.txt'))).toMatchObject({ status: 'partial', failed: 1 });
    expect((await cleanupUnreferencedToolOutputs(path.join(root, 'retained.txt'), new Set())).failed).toBe(1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

async function writeFileWithMtime(
  filePath: string,
  content: string,
  ageMs: number,
  now: number,
): Promise<void> {
  await fs.writeFile(filePath, content, 'utf-8');
  const mtimeMs = now - ageMs;
  const t = new Date(mtimeMs);
  await fs.utimes(filePath, t, t);
}

describe('cleanupExpiredToolOutputs', () => {
  let dir: string;
  const NOW = 2_000_000_000_000; // fixed clock — 2033-05-18T03:33:20Z

  beforeEach(async () => {
    dir = await makeTempDir();
    __resetGcCooldownForTests();
  });

  afterEach(async () => {
    setAgentConfigHome(undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns empty result when directory is missing (no throw)', async () => {
    const missing = path.join(dir, 'does-not-exist');
    const r = await cleanupExpiredToolOutputs(missing, DAY_MS, NOW);
    expect(r).toEqual({ scanned: 0, removed: 0, failed: 0, bytesRemoved: 0 });
  });

  it('does NOT remove files inside the TTL window', async () => {
    await writeFileWithMtime(path.join(dir, 'fresh-1.txt'), 'hello', HOUR_MS, NOW);
    await writeFileWithMtime(path.join(dir, 'fresh-2.txt'), 'world', 5 * HOUR_MS, NOW);

    const r = await cleanupExpiredToolOutputs(dir, DAY_MS, NOW);

    expect(r.scanned).toBe(2);
    expect(r.removed).toBe(0);
    expect(r.failed).toBe(0);
    expect((await fs.readdir(dir)).sort()).toEqual(['fresh-1.txt', 'fresh-2.txt']);
  });

  it('removes only the files older than the TTL window', async () => {
    await writeFileWithMtime(path.join(dir, 'fresh.txt'), 'fresh', HOUR_MS, NOW);
    await writeFileWithMtime(path.join(dir, 'stale-1.txt'), 'stale1', 2 * DAY_MS, NOW);
    await writeFileWithMtime(path.join(dir, 'stale-2.txt'), 'stale2-longer', 30 * DAY_MS, NOW);

    const r = await cleanupExpiredToolOutputs(dir, DAY_MS, NOW);

    expect(r.scanned).toBe(3);
    expect(r.removed).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.bytesRemoved).toBe(
      Buffer.byteLength('stale1', 'utf-8') + Buffer.byteLength('stale2-longer', 'utf-8'),
    );
    expect(await fs.readdir(dir)).toEqual(['fresh.txt']);
  });

  it('does NOT recurse into subdirectories (reserved for future per-session namespacing)', async () => {
    const sub = path.join(dir, 'session-abc');
    await fs.mkdir(sub);
    await writeFileWithMtime(path.join(sub, 'in-subdir.txt'), 'sub', 30 * DAY_MS, NOW);
    await writeFileWithMtime(path.join(dir, 'top-level-stale.txt'), 'top', 30 * DAY_MS, NOW);

    const r = await cleanupExpiredToolOutputs(dir, DAY_MS, NOW);

    // The subdir itself is not counted as a "scanned file" and is not removed.
    expect(r.scanned).toBe(1);
    expect(r.removed).toBe(1);
    // Subdir + its contents are untouched.
    expect(await fs.readdir(sub)).toEqual(['in-subdir.txt']);
  });

  it('uses default 14-day TTL when ttlMs is omitted', async () => {
    expect(DEFAULT_TOOL_OUTPUT_TTL_MS).toBe(14 * DAY_MS);
    // Use the live wall clock for both mtime computation AND the GC call
    // so the default-`now`-parameter branch is exercised (the assertion
    // would always fail if we passed a fixed clock without matching mtimes).
    const liveNow = Date.now();
    await writeFileWithMtime(path.join(dir, 'edge-13d.txt'), 'edge', 13 * DAY_MS, liveNow);
    await writeFileWithMtime(path.join(dir, 'edge-15d.txt'), 'edge', 15 * DAY_MS, liveNow);

    const r = await cleanupExpiredToolOutputs(dir);

    expect(r.removed).toBe(1);
    expect(await fs.readdir(dir)).toEqual(['edge-13d.txt']);
  });

  it('keeps stale artifacts that are still referenced by resumable sessions', async () => {
    const referenced = path.join(dir, 'referenced.txt');
    const orphaned = path.join(dir, 'orphaned.txt');
    await writeFileWithMtime(referenced, 'needed', 30 * DAY_MS, NOW);
    await writeFileWithMtime(orphaned, 'dead', 30 * DAY_MS, NOW);

    const result = await cleanupUnreferencedToolOutputs(
      dir,
      new Set([referenced]),
      DAY_MS,
      NOW,
    );

    expect(result.removed).toBe(1);
    expect(await fs.readdir(dir)).toEqual(['referenced.txt']);
  });

  it('does not sweep through a tool-results link into Runtime', async () => {
    const agentHome = path.join(dir, 'agent-home');
    const runtimeDirectory = path.join(agentHome, 'runtime');
    const outputLink = path.join(agentHome, 'tool-results');
    const runtimeFile = path.join(runtimeDirectory, 'state.json');
    await fs.mkdir(runtimeDirectory, { recursive: true });
    await fs.writeFile(runtimeFile, 'control-plane', 'utf8');
    await fs.utimes(runtimeFile, new Date(0), new Date(0));
    await fs.symlink(
      runtimeDirectory,
      outputLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    setAgentConfigHome(agentHome);

    const expired = await cleanupExpiredToolOutputs(outputLink, 0, NOW);
    const unreferenced = await cleanupUnreferencedToolOutputs(
      outputLink,
      new Set(),
      0,
      NOW,
    );

    expect(expired.failed).toBe(1);
    expect(unreferenced.failed).toBe(1);
    await expect(fs.readFile(runtimeFile, 'utf8')).resolves.toBe('control-plane');
  });
});

describe('maybeRunToolOutputGc', () => {
  let dir: string;
  const NOW = 2_000_000_000_000;

  beforeEach(async () => {
    dir = await makeTempDir();
    __resetGcCooldownForTests();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps cooldown and in-flight cleanup separate for different storage roots', async () => {
    const other = path.join(dir, 'other');
    await fs.mkdir(other);
    await writeFileWithMtime(path.join(dir, 'stale.txt'), 'old', 30 * DAY_MS, NOW);
    await writeFileWithMtime(path.join(other, 'stale.txt'), 'other', 30 * DAY_MS, NOW);
    await Promise.all([maybeRunToolOutputGc(dir, DAY_MS, NOW), maybeRunToolOutputGc(other, DAY_MS, NOW)]);
    await expect(fs.stat(path.join(other, 'stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('launches a sweep on first call and reports a non-null result', async () => {
    await writeFileWithMtime(path.join(dir, 'stale.txt'), 'old', 30 * DAY_MS, NOW);

    const result = await maybeRunToolOutputGc(dir, DAY_MS, NOW);

    expect(result).not.toBeNull();
    expect(result!.removed).toBe(1);
  });

  it('returns null on a second call within the cooldown window', async () => {
    const first = await maybeRunToolOutputGc(dir, DAY_MS, NOW);
    expect(first).not.toBeNull();

    // 30 minutes later, still under the 1h cooldown.
    const second = await maybeRunToolOutputGc(dir, DAY_MS, NOW + 30 * 60 * 1000);
    expect(second).toBeNull();
  });

  it('launches a fresh sweep after the cooldown window expires', async () => {
    const first = await maybeRunToolOutputGc(dir, DAY_MS, NOW);
    expect(first).not.toBeNull();

    // Just past the cooldown.
    const second = await maybeRunToolOutputGc(dir, DAY_MS, NOW + GC_COOLDOWN_MS + 1);
    expect(second).not.toBeNull();
  });

  it('coalesces overlapping concurrent calls onto the same in-flight sweep', async () => {
    await writeFileWithMtime(path.join(dir, 'stale.txt'), 'old', 30 * DAY_MS, NOW);

    const [a, b] = await Promise.all([
      maybeRunToolOutputGc(dir, DAY_MS, NOW),
      maybeRunToolOutputGc(dir, DAY_MS, NOW),
    ]);

    // Both calls return the same in-flight promise's result — the second
    // does NOT skip with null because we coalesce instead.
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // And the file was removed exactly once (no double-unlink errors).
    expect(a!.removed).toBe(1);
  });
});
