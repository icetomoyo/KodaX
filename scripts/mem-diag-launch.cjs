#!/usr/bin/env node
/**
 * Launcher for `npm run dev:mem-diag`.
 *
 * Cross-platform env-var + flag setup for memory diagnostics runs.
 * Spawns the dev CLI with:
 *   - KODAX_MEMORY_DIAG=1   (enables ~/.kodax/memory-diag.log output)
 *   - --expose-gc           (lets the diag tool call global.gc() after each
 *                            snapshot and report "after forced GC" — distin-
 *                            guishing a real leak from "GC hasn't run yet")
 *   - --max-old-space-size=4096 and the production NODE_ENV preload,
 *     matching the normal `npm run dev` behavior.
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'kodax_cli.ts');
const preload = path.join(root, 'scripts', 'production-env.cjs');

// Level precedence:
//   1. explicit KODAX_MEMORY_DIAG env var wins
//   2. otherwise use the CLI arg passed by npm (--level=2 / "2")
//   3. default to level 1 (log only, no heap snapshot)
const cliLevelArg = process.argv.slice(2).find(a => /^(--level=|level=)?[12]$/.test(a));
const cliLevel = cliLevelArg ? cliLevelArg.replace(/^(--level=|level=)/, '') : undefined;
const level = process.env.KODAX_MEMORY_DIAG ?? cliLevel ?? '1';

const env = {
  ...process.env,
  KODAX_MEMORY_DIAG: level,
};

console.error(`[mem-diag-launch] KODAX_MEMORY_DIAG=${level}`
  + (level === '2' ? '  (heap snapshots ENABLED — ~/.kodax/heap-*.heapsnapshot)' : '  (log only; pass 2 to also dump heap snapshots)'));

const args = [
  '--max-old-space-size=4096',
  '--expose-gc',
  '--require', preload,
  '--import', 'tsx',
  entry,
];

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env,
  cwd: root,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
