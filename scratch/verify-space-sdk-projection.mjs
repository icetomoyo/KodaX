// Four real Space render paths, using one SDK projection and an explicit journal fixture/copy.
// Temporary bundles are removed even when an assertion fails.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const [projectionPath, journalPath] = process.argv.slice(2);
assert(projectionPath && journalPath, 'Usage: <SDK projection.json> <delivery journal.jsonl>');
await mkdir('scratch', { recursive: true });
const directory = await mkdtemp(path.resolve('scratch', 'space-identity-check-'));
const results = [];
try {
  const outfile = path.join(directory, 'replay.cjs');
  await build({ entryPoints: ['scratch/space-sdk-session-replay.ts'], outfile,
    bundle: true, platform: 'node', format: 'cjs', external: ['typescript'], logLevel: 'silent' });
  for (const mode of ['live-history', 'late-delivery', 'cold', 'repeat-delivery']) {
    const result = spawnSync(process.execPath, [outfile, path.resolve(projectionPath), mode,
      path.resolve(journalPath)], { encoding: 'utf8', windowsHide: true });
    const line = result.stdout?.split(/\r?\n/).find((value) => value.startsWith('{'));
    const evidence = line ? JSON.parse(line) : { mode, error: 'Probe failed before rendering' };
    results.push({ ...evidence, passed: result.status === 0 });
  }
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  assert(results.every((result) => result.passed), 'All four real Space paths must render exactly Q,A.');
} finally { await rm(directory, { recursive: true, force: true }); }
