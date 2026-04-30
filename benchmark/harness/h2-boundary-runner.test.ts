/**
 * FEATURE_107 P3.1 — End-to-end plumbing test for the H2 boundary eval
 * orchestrator. Uses a deterministic fake kodax bin (a small node script)
 * so we exercise:
 *   - worktree setup at gitHeadSha
 *   - subprocess spawn with binOverride
 *   - HOME / USERPROFILE isolation (the fake bin writes its session jsonl
 *     to `$HOME/.kodax/sessions/` and the test reads it back from the
 *     captured path)
 *   - variant-forcing env propagation (fake bin echoes env vars into its
 *     output, test asserts they arrived)
 *   - filesChanged detection from worktree git state
 *   - mustTouchHits / mustNotTouchViolations computation
 *   - results persistence (matrix.json + per-cell meta.json + session.jsonl)
 *
 * What this DOES NOT test:
 *   - real KodaX behavior (no LLM calls)
 *   - the source-side P2.1 env hooks themselves (those have their own
 *     unit tests in `packages/coding/src/task-engine/feature-107-hooks.test.ts`)
 *
 * P3.2 (manual, 1 real-LLM cell) covers the actual LLM integration end-to-end.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { describe, expect, it, afterEach } from 'vitest';

import { runH2BoundaryEval } from './h2-boundary-runner.js';

const repoRoot = process.cwd();

/**
 * Write a small node script that pretends to be `kodax`. It:
 *   - reads HOME / variant env vars, encodes them in the session jsonl
 *   - writes `$HOME/.kodax/sessions/<id>.jsonl` with one line per simulated event
 *   - touches a file in cwd to simulate a "Generator wrote" effect
 *   - prints a 1-line stdout summary
 *   - exits 0
 *
 * Returns absolute path to the script (caller plugs into binOverride).
 */
async function makeFakeKodaxBin(scriptDir: string, touchFile = 'EVAL_TOUCHED.txt'): Promise<string> {
  const scriptPath = path.join(scriptDir, 'fake-kodax.cjs');
  const body = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

// Parse minimal args: -p <userMessage> --provider X --model Y
const argv = process.argv.slice(2);
let prompt = '';
let provider = '';
let model = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-p' || argv[i] === '--print') prompt = argv[i+1] || '';
  if (argv[i] === '--provider') provider = argv[i+1] || '';
  if (argv[i] === '--model') model = argv[i+1] || '';
}

const home = process.env.HOME || os.homedir();
const sessionsDir = path.join(home, '.kodax', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

const sessionId = 'fake-' + Date.now();
const sessionPath = path.join(sessionsDir, sessionId + '.jsonl');
const events = [
  { type: 'meta', title: prompt.slice(0, 80), provider, model },
  { type: 'env', forceMaxHarness: process.env.KODAX_FORCE_MAX_HARNESS || null,
                   plannerInputFilter: process.env.KODAX_PLANNER_INPUTFILTER || null },
  { type: 'simulated_tool_call', name: 'write', file: ${JSON.stringify(touchFile)} },
];
fs.writeFileSync(sessionPath, events.map(e => JSON.stringify(e)).join('\\n'));

// Simulate a Generator file mutation in cwd so filesChanged surfaces it.
fs.writeFileSync(path.join(process.cwd(), ${JSON.stringify(touchFile)}),
                 'fake kodax run for ' + sessionId);

process.stdout.write('FAKE_KODAX_OK session=' + sessionId);
process.exit(0);
`;
  await fs.writeFile(scriptPath, body, 'utf8');
  return scriptPath;
}

const ALIAS = 'ds/v4flash';
const ALIAS_KEY_ENV = 'DEEPSEEK_API_KEY';

describe('h2-boundary-runner — end-to-end plumbing (fake kodax)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  // Stub the API key the alias expects so providerEnv() doesn't throw.
  const originalKey = process.env[ALIAS_KEY_ENV];
  process.env[ALIAS_KEY_ENV] = 'fake-key-for-plumbing-test';

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  // Restore the real key after the suite — vitest doesn't auto-isolate envs.
  afterEach(() => {
    if (originalKey === undefined) delete process.env[ALIAS_KEY_ENV];
    else process.env[ALIAS_KEY_ENV] = originalKey;
  });

  // Worktree setup + subprocess spawn + git diff add up to 1-3s on a hot
  // box; under parallel test pressure this can exceed vitest's 5s default.
  // Generous 30s ceiling per test absorbs that without masking real hangs.
  it('runs 1 case × 1 alias × 1 variant: spawns fake kodax, captures session, persists matrix', { timeout: 30_000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(tmpdir(), 'h2-boundary-test-'));
    cleanups.push(async () => { await fs.rm(tmp, { recursive: true, force: true }); });
    const fakeBin = await makeFakeKodaxBin(tmp);
    const resultsRoot = path.join(tmp, 'results');

    const result = await runH2BoundaryEval({
      cases: [
        {
          id: 'plumbing-smoke-001',
          userMessage: 'create a file called EVAL_TOUCHED.txt',
          gitHeadSha: null,  // HEAD is fine for plumbing test
          mustTouchFiles: ['EVAL_TOUCHED.txt'],
          mustNotTouchFiles: ['packages/'],
        },
      ],
      aliases: [ALIAS],
      variants: ['H2-A'],
      resultsRoot,
      repoRoot,
      skipOrphanScan: true,
      binOverride: { command: 'node', args: [fakeBin] },
    });

    // Exit code + stdout marker
    expect(result.cells).toHaveLength(1);
    const cell = result.cells[0];
    expect(cell.task.processOk).toBe(true);
    expect(cell.task.timedOut).toBe(false);
    expect(cell.task.stdoutTail).toMatch(/FAKE_KODAX_OK session=fake-/);

    // Session jsonl was written under the isolated HOME, captured, and
    // persisted to the per-cell results dir. We read from the persisted
    // copy because `cleanupAgentTaskArtifacts` (called inside the run) has
    // already removed the original isolated-home path by the time we look.
    expect(cell.task.sessionJsonlPath).not.toBeNull();
    const jsonl = await fs.readFile(path.join(cell.persistedAt, 'session.jsonl'), 'utf8');
    expect(jsonl).toMatch(/"forceMaxHarness":"H2"/);  // variant H2-A → KODAX_FORCE_MAX_HARNESS=H2
    expect(jsonl).toMatch(/"plannerInputFilter":null/);  // H2-A doesn't set strip-reasoning

    // Generator effect captured: filesChanged includes EVAL_TOUCHED.txt
    expect(cell.task.filesChanged).toContain('EVAL_TOUCHED.txt');
    expect(cell.mustTouchHits).toEqual(['EVAL_TOUCHED.txt']);
    expect(cell.mustNotTouchViolations).toEqual([]);

    // Per-cell artifacts persisted
    const meta = JSON.parse(
      await fs.readFile(path.join(cell.persistedAt, 'meta.json'), 'utf8'),
    );
    expect(meta.caseId).toBe('plumbing-smoke-001');
    expect(meta.alias).toBe(ALIAS);
    expect(meta.variant).toBe('H2-A');
    expect(meta.processOk).toBe(true);

    // Matrix rollup at results root
    const matrix = JSON.parse(
      await fs.readFile(path.join(result.resultsDir, 'matrix.json'), 'utf8'),
    );
    expect(matrix.cells).toHaveLength(1);
    expect(matrix.primaryHeadUntouched.ok).toBe(true);
  });

  it('H2-B variant propagates KODAX_PLANNER_INPUTFILTER=strip-reasoning to the spawn', { timeout: 30_000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(tmpdir(), 'h2-boundary-test-'));
    cleanups.push(async () => { await fs.rm(tmp, { recursive: true, force: true }); });
    const fakeBin = await makeFakeKodaxBin(tmp);

    const result = await runH2BoundaryEval({
      cases: [
        {
          id: 'plumbing-smoke-002',
          userMessage: 'task',
          gitHeadSha: null,
          mustTouchFiles: [],
          mustNotTouchFiles: [],
        },
      ],
      aliases: [ALIAS],
      variants: ['H2-B'],
      resultsRoot: path.join(tmp, 'results'),
      repoRoot,
      skipOrphanScan: true,
      binOverride: { command: 'node', args: [fakeBin] },
    });

    const jsonl = await fs.readFile(
      path.join(result.cells[0].persistedAt, 'session.jsonl'),
      'utf8',
    );
    expect(jsonl).toMatch(/"forceMaxHarness":"H2"/);
    expect(jsonl).toMatch(/"plannerInputFilter":"strip-reasoning"/);
  });

  it('H1-ref variant propagates KODAX_FORCE_MAX_HARNESS=H1', { timeout: 30_000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(tmpdir(), 'h2-boundary-test-'));
    cleanups.push(async () => { await fs.rm(tmp, { recursive: true, force: true }); });
    const fakeBin = await makeFakeKodaxBin(tmp);

    const result = await runH2BoundaryEval({
      cases: [
        {
          id: 'plumbing-smoke-003',
          userMessage: 'task',
          gitHeadSha: null,
          mustTouchFiles: [],
          mustNotTouchFiles: [],
        },
      ],
      aliases: [ALIAS],
      variants: ['H1-ref'],
      resultsRoot: path.join(tmp, 'results'),
      repoRoot,
      skipOrphanScan: true,
      binOverride: { command: 'node', args: [fakeBin] },
    });

    const jsonl = await fs.readFile(
      path.join(result.cells[0].persistedAt, 'session.jsonl'),
      'utf8',
    );
    expect(jsonl).toMatch(/"forceMaxHarness":"H1"/);
    expect(jsonl).toMatch(/"plannerInputFilter":null/);
  });

  it('mustNotTouchViolations fires when the agent touches a forbidden path', { timeout: 30_000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(tmpdir(), 'h2-boundary-test-'));
    cleanups.push(async () => { await fs.rm(tmp, { recursive: true, force: true }); });
    // Unique filename per test invocation to avoid accidental collision with
    // other parallel test files that might happen to write similar names.
    const touchFile = `EVAL_TOUCHED_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`;
    const fakeBin = await makeFakeKodaxBin(tmp, touchFile);

    const result = await runH2BoundaryEval({
      cases: [
        {
          id: 'plumbing-smoke-004',
          userMessage: 'task',
          gitHeadSha: null,
          mustTouchFiles: [],
          mustNotTouchFiles: [touchFile],
        },
      ],
      aliases: [ALIAS],
      variants: ['H2-A'],
      resultsRoot: path.join(tmp, 'results'),
      repoRoot,
      skipOrphanScan: true,
      binOverride: { command: 'node', args: [fakeBin] },
    });

    expect(result.cells[0].mustNotTouchViolations).toContain(touchFile);
  });
});
