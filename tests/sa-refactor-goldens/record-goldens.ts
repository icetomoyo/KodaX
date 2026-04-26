#!/usr/bin/env node
/**
 * SA Refactor Goldens — Recording Driver
 *
 * Wraps `runKodaX` with a `RecorderProvider`, runs a small batch of selected
 * sessions, and writes one `<sessionId>.json` recording per session.
 *
 * Cost model
 * ==========
 * Per-session cost ≈ (avg_turns × tokens_per_turn × provider_rate). With
 * `deepseek-v4-flash` and `maxIter: 8`, a typical session is ~50k input +
 * ~12k output tokens ≈ $0.02 USD. The full 46-session selection is ~$1 USD.
 * Use `--limit 1` first to smoke-test the harness; only then commit to the
 * full corpus recording.
 *
 * Sandbox
 * =======
 * KodaX file-edit tools mutate the cwd. To prevent recording runs from
 * polluting the live repo, each session executes inside a `git worktree
 * add` of HEAD; the worktree is removed on exit (success OR failure).
 *
 * Virtual provider registration
 * =============================
 * `registerModelProvider` rejects names that collide with built-ins, so we
 * register under a `__recorder_${innerName}__` namespace. The factory
 * returns a fresh `RecorderProvider` wrapping a fresh inner provider so
 * concurrent runs don't share `maxOutputTokensOverride` state.
 *
 * Usage
 * =====
 *   tsx tests/sa-refactor-goldens/record-goldens.ts \
 *     --inner-provider deepseek \
 *     --inner-model    deepseek-v4-flash \
 *     --limit 1 \
 *     --out-dir tests/sa-refactor-goldens/recordings
 */

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
  registerModelProvider,
  resolveProvider,
  type KodaXBaseProvider,
} from '@kodax/ai';
import { runKodaX } from '@kodax/coding';

import { listSessionFiles, parseSessionFile } from './session-parser.js';
import { selectSessions, type SelectedSession } from './selection.js';
import { RecorderProvider } from './providers.js';

interface CliArgs {
  innerProvider: string;
  innerModel?: string;
  limit: number;
  outDir: string;
  sessionsDir: string;
  maxIter: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    innerProvider: 'deepseek',
    innerModel: 'deepseek-v4-flash',
    limit: 1,
    outDir: path.resolve('tests/sa-refactor-goldens/recordings'),
    sessionsDir: path.join(os.homedir(), '.kodax', 'sessions'),
    maxIter: 8,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = argv[i + 1];
    if (flag === '--inner-provider' && next) { args.innerProvider = next; i++; }
    else if (flag === '--inner-model' && next) { args.innerModel = next; i++; }
    else if (flag === '--limit' && next) { args.limit = Number(next); i++; }
    else if (flag === '--out-dir' && next) { args.outDir = path.resolve(next); i++; }
    else if (flag === '--sessions-dir' && next) { args.sessionsDir = next; i++; }
    else if (flag === '--max-iter' && next) { args.maxIter = Number(next); i++; }
  }
  return args;
}

interface SandboxHandle {
  worktreePath: string;
  cleanup: () => Promise<void>;
}

async function createSandbox(label: string): Promise<SandboxHandle> {
  // Use an OS temp dir under a stable prefix so accidental leaks are easy to
  // grep + nuke. Using `git worktree` keeps the sandbox a real KodaX checkout
  // (so prompts that reference repo paths still resolve to readable files).
  const sandboxRoot = path.join(os.tmpdir(), 'kodax-record');
  await fs.mkdir(sandboxRoot, { recursive: true });
  const worktreePath = path.join(sandboxRoot, `${label}-${process.pid}-${Date.now()}`);

  const add = spawnSync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  if (add.status !== 0) {
    throw new Error(`git worktree add failed: ${add.stderr || add.stdout}`);
  }

  return {
    worktreePath,
    cleanup: async () => {
      // `git worktree remove --force` handles dirty worktrees (the recording
      // run writes files; we don't care about them).
      const remove = spawnSync('git', ['worktree', 'remove', '--force', worktreePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      if (remove.status !== 0) {
        // Worktree already gone, or git pruned it. Best-effort: rm -rf.
        await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

interface RecordOutcome {
  sessionId: string;
  status: 'recorded' | 'failed';
  error?: string;
  callCount?: number;
  filePath?: string;
  durationMs?: number;
}

async function recordOneSession(
  selected: SelectedSession,
  prompt: string,
  args: CliArgs,
): Promise<RecordOutcome> {
  const startedAt = Date.now();
  const sandbox = await createSandbox(selected.sessionId);
  let unregister: (() => void) | undefined;
  let recorder: RecorderProvider | undefined;

  try {
    // Build the inner provider with the user's real config (env-key driven).
    const inner: KodaXBaseProvider = resolveProvider(args.innerProvider);
    if (!inner.isConfigured()) {
      throw new Error(
        `inner provider "${args.innerProvider}" not configured (set ${inner.getApiKeyEnv()})`,
      );
    }

    // Register a virtual provider name pointing at our recorder. Built-in
    // provider names take precedence in `resolveProvider`, so we MUST use a
    // namespace that won't collide.
    const virtualName = `__recorder_${args.innerProvider}_${selected.sessionId}__`;
    recorder = new RecorderProvider(inner, selected.sessionId);
    unregister = registerModelProvider(virtualName, () => recorder!);

    // Ensure the per-session recordings dir exists.
    await fs.mkdir(args.outDir, { recursive: true });

    // Drive runKodaX. We pass:
    //  - provider:  the virtual name (so resolveProvider returns the recorder)
    //  - model:     the user-chosen inner model (e.g., deepseek-v4-flash)
    //  - context:   gitRoot + executionCwd both pointing at the sandbox
    //               worktree, so any file mutations land there
    //  - agentMode: 'sa' — SA topology is what FEATURE_100 must preserve;
    //               we are explicitly NOT recording AMA flows here
    //  - maxIter:   conservative cap; runaway sessions cost real money
    await runKodaX(
      {
        provider: virtualName,
        model: args.innerModel,
        agentMode: 'sa',
        maxIter: args.maxIter,
        context: {
          gitRoot: sandbox.worktreePath,
          executionCwd: sandbox.worktreePath,
        },
      },
      prompt,
    );

    const filePath = await recorder.writeTo(args.outDir);
    return {
      sessionId: selected.sessionId,
      status: 'recorded',
      callCount: recorder.buildRecording().calls.length,
      filePath,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      sessionId: selected.sessionId,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    unregister?.();
    await sandbox.cleanup();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log('=== record-goldens ===');
  console.log(`  inner provider: ${args.innerProvider}`);
  console.log(`  inner model:    ${args.innerModel ?? '(provider default)'}`);
  console.log(`  limit:          ${args.limit}`);
  console.log(`  maxIter:        ${args.maxIter}`);
  console.log(`  sessions dir:   ${args.sessionsDir}`);
  console.log(`  out dir:        ${args.outDir}`);
  console.log('');

  // Validate inner provider config up front so we fail before spinning up a
  // worktree if the API key is missing.
  const inner = resolveProvider(args.innerProvider);
  if (!inner.isConfigured()) {
    console.error(
      `error: inner provider "${args.innerProvider}" not configured. Set ${inner.getApiKeyEnv()}.`,
    );
    process.exit(1);
  }

  console.log('scanning sessions...');
  const files = await listSessionFiles(args.sessionsDir);
  const sessions = await Promise.all(files.map(parseSessionFile));
  const report = selectSessions(sessions);
  console.log(`  selected ${report.selected.length} session(s) out of ${report.totalCandidates}`);

  // Sessions with the most-matched detectors first — front-load coverage in
  // case the run is aborted partway.
  const ordered = [...report.selected].sort(
    (a, b) => b.matchedDetectors.length - a.matchedDetectors.length,
  );

  // Filter out sessions whose log starts with a system summary (no user
  // message to use as a prompt) BEFORE applying the limit. These sessions
  // are recoverable via /resume in the live KodaX flow but our recorder
  // needs an initial prompt to drive runKodaX.
  const recordable: Array<{ selected: SelectedSession; prompt: string }> = [];
  let skippedEmpty = 0;
  for (const selected of ordered) {
    const raw = await parseSessionFile(selected.filePath);
    const prompt = raw.metadata.initialPromptText;
    if (!prompt) {
      skippedEmpty += 1;
      continue;
    }
    recordable.push({ selected, prompt });
    if (recordable.length >= args.limit) break;
  }
  if (skippedEmpty > 0) {
    console.log(`  skipped ${skippedEmpty} session(s) with no initial user prompt (likely /resume continuations)`);
  }

  console.log(`recording ${recordable.length} session(s)...\n`);

  const outcomes: RecordOutcome[] = [];
  for (let i = 0; i < recordable.length; i++) {
    const { selected, prompt } = recordable[i]!;
    process.stdout.write(`[${i + 1}/${recordable.length}] ${selected.sessionId} (${selected.bucket}/${selected.family}) ... `);

    const outcome = await recordOneSession(selected, prompt, args);
    outcomes.push(outcome);

    if (outcome.status === 'recorded') {
      console.log(`OK (${outcome.callCount} calls, ${(outcome.durationMs ?? 0) / 1000}s) → ${outcome.filePath}`);
    } else {
      console.log(`FAIL (${outcome.error})`);
    }
  }

  const ok = outcomes.filter((o) => o.status === 'recorded').length;
  const fail = outcomes.filter((o) => o.status === 'failed').length;
  const totalCalls = outcomes.reduce((acc, o) => acc + (o.callCount ?? 0), 0);
  const totalDurationMs = outcomes.reduce((acc, o) => acc + (o.durationMs ?? 0), 0);

  console.log('\n=== Summary ===');
  console.log(`  recorded: ${ok}`);
  console.log(`  failed:   ${fail}`);
  console.log(`  total provider calls: ${totalCalls}`);
  console.log(`  total wall time: ${(totalDurationMs / 1000).toFixed(1)}s`);

  if (fail > 0) {
    console.log('\nfailures:');
    for (const o of outcomes.filter((x) => x.status === 'failed')) {
      console.log(`  - ${o.sessionId}: ${o.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('record-goldens fatal:', err);
  process.exit(1);
});
