/**
 * FEATURE_107 (v0.7.32) — Agent-level task runner for H2 plan-execute
 * boundary eval. Runs ONE (case, alias, variant) cell in a fully isolated
 * worktree by spawning the `kodax -p <userMessage>` non-interactive entry.
 *
 * Distinct from `harness.ts` (prompt-eval, single LLM call, no filesystem
 * effect) — this module:
 *   - sets up an isolated git worktree (via `worktree-runner.ts`)
 *   - sets up an isolated KODAX HOME (so eval session jsonl doesn't pollute
 *     the user's real `~/.kodax/sessions/`)
 *   - spawns `kodax -p` with provider/model overrides + variant-forcing env
 *     vars + HEAD-pinned worktree as cwd
 *   - waits for exit, then reads the eval-only session jsonl back to extract
 *     metrics (token counts, context peak, harness verdict, etc.)
 *
 * Variant-forcing env vars (consumed by KodaX source side, P2.1):
 *   - `KODAX_FORCE_MAX_HARNESS`     — 'H1' / 'H2' / unset (bypass Scout verdict)
 *   - `KODAX_PLANNER_INPUTFILTER`   — 'strip-reasoning' / unset (activate
 *                                     plannerHandoffs inputFilter, B-path)
 *
 * Re-framed 2026-04-30 (was `KODAX_PLANNER_GENERATOR_MERGED`) — design pass
 * found A current behavior is already same-session, so B-path = "add an
 * inputFilter that strips Planner's reasoning, leaving only plan artifact"
 * (v0.7.16 design intent). Source change is ~10 lines, not 30-80.
 *
 * P2.0 ships this file with the contract. P2.1 wires the env reads into
 * `runner-driven.ts` (~10 lines total). Until P2.1 lands, variants are
 * recorded but not behaviorally enforced.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

import {
  cleanupWorktree,
  setupWorktree,
  type WorktreeHandle,
} from './worktree-runner.js';
import { resolveAlias, type ModelAlias } from './aliases.js';

export type EvalVariant = 'H2-A' | 'H2-B' | 'H1-ref';

export interface AgentTaskInput {
  /** Case ID — used for worktree naming + log lines. */
  readonly caseId: string;
  /** User message that gets passed to `kodax -p`. */
  readonly userMessage: string;
  /** Repo SHA the worktree should be checked out at. `null` → HEAD. */
  readonly gitHeadSha: string | null;
  /** Model alias the agent should run on. */
  readonly alias: ModelAlias;
  /** Which eval variant to force. */
  readonly variant: EvalVariant;
  /** Wall-clock cap. Hard kill on exceed. Default: 10 min. */
  readonly timeoutMs?: number;
  /** Override repo root (test seam). Default: `cwd`. */
  readonly repoRoot?: string;
  /**
   * Override how `kodax` is invoked. Three forms supported:
   *   - `undefined` (default) → spawn `kodax` via PATH lookup. Requires
   *     globally installed bin. Honors P2.1 env hooks ONLY if installed bin
   *     was built from current source.
   *   - `{ command, args }` → spawn arbitrary binary with prepended args
   *     (e.g. `{ command: 'node', args: ['<repo>/dist/kodax_cli.js'] }` to
   *     use a freshly built dist, or fake bin for tests).
   *
   * The `args: ['-p', userMessage, '--provider', X, '--model', Y]` is then
   * appended to whatever the override produces.
   */
  readonly binOverride?: { command: string; args?: readonly string[] };
  /**
   * Copy primary repo's node_modules into the worktree (root + monorepo
   * packages/* node_modules). Default false. Eval cases that ask the agent
   * to "verify with tests / build" otherwise burn the timeout cycling
   * through `pnpm/npm install` attempts because git worktree doesn't carry
   * gitignored node_modules. See `worktree-runner.ts:seedNodeModulesIntoWorktree`.
   *
   * 2026-05-01 (v0.7.32 P5): switched from symlink (~0s, leaky) to copy
   * (~28s, fully isolated). Symlinked node_modules let an agent's
   * `npm install` mutate the primary repo's node_modules; copy contains
   * everything inside the worktree's own files.
   */
  readonly seedNodeModules?: boolean;
  /**
   * Extra env vars forwarded to the spawned KodaX process, on top of HOME /
   * provider key / variant-forcing flags. Used by FEATURE_107 P5 to flip
   * `KODAX_GENERATOR_REASONING_DISCIPLINE=on` for the discipline-prompt A/B
   * experiment without touching `variantEnv`. Production code never sets
   * these; eval-only flags are scrubbed at P6 cleanup.
   */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export interface AgentTaskResult {
  readonly caseId: string;
  readonly alias: ModelAlias;
  readonly variant: EvalVariant;
  readonly exitCode: number | null;
  /** True when the process exited 0 (process-level OK; doesn't imply
   *  Evaluator accepted). */
  readonly processOk: boolean;
  /** True if hard-killed by timeout. */
  readonly timedOut: boolean;
  /** Wall-clock elapsed for the spawn (excludes worktree setup/teardown). */
  readonly durationMs: number;
  /** Path to the captured session jsonl (under the isolated HOME).
   *  Caller can post-mortem this file before it's torn down. */
  readonly sessionJsonlPath: string | null;
  /** Files modified inside the worktree, relative to worktree root. */
  readonly filesChanged: readonly string[];
  /** Captured stdout (truncated to last 64KB to keep result objects small). */
  readonly stdoutTail: string;
  /** Captured stderr (truncated to last 64KB). */
  readonly stderrTail: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_BYTES = 64 * 1024;

function tail(buf: string, n: number): string {
  if (buf.length <= n) return buf;
  return buf.slice(buf.length - n);
}

function variantEnv(variant: EvalVariant): Record<string, string> {
  switch (variant) {
    case 'H1-ref':
      return { KODAX_FORCE_MAX_HARNESS: 'H1' };
    case 'H2-A':
      // "naked" — current code behavior, no inputFilter
      return { KODAX_FORCE_MAX_HARNESS: 'H2' };
    case 'H2-B':
      // "filtered" — Planner→Generator handoff strips Planner reasoning,
      // Generator sees only plan artifact (v0.7.16 design intent)
      return {
        KODAX_FORCE_MAX_HARNESS: 'H2',
        KODAX_PLANNER_INPUTFILTER: 'strip-reasoning',
      };
  }
}

function providerEnv(alias: ModelAlias): { name: string; value: string } {
  const target = resolveAlias(alias);
  const apiKey = process.env[target.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `agent-task-runner: API key env ${target.apiKeyEnv} not set for alias ${alias}`,
    );
  }
  return { name: target.apiKeyEnv, value: apiKey };
}

/**
 * List the most recent session jsonl created in `sessionsDir`. The eval
 * spawn produces exactly one jsonl per run because HOME is isolated.
 */
async function findEvalSessionJsonl(sessionsDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return null;
  }
  const jsonl = entries.filter((e) => e.endsWith('.jsonl'));
  if (jsonl.length === 0) return null;
  // Stat to find most recent — typical eval produces one file but be safe.
  const stats = await Promise.all(
    jsonl.map(async (name) => {
      const p = path.join(sessionsDir, name);
      const s = await fs.stat(p);
      return { p, mtimeMs: s.mtimeMs };
    }),
  );
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stats[0].p;
}

/**
 * Diff worktree against its base SHA to enumerate files the agent modified.
 * Uses `git diff --name-only <base-sha>` from inside the worktree. Returns
 * file paths relative to worktree root.
 */
async function listFilesChangedInWorktree(
  handle: WorktreeHandle,
): Promise<readonly string[]> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  // First include tracked changes vs base, then untracked (new files).
  try {
    const { stdout: tracked } = await execFileAsync(
      'git',
      ['diff', '--name-only', handle.sha],
      { cwd: handle.path },
    );
    const { stdout: untracked } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      { cwd: handle.path },
    );
    const all = [
      ...tracked.split('\n').filter(Boolean),
      ...untracked.split('\n').filter(Boolean),
    ];
    return Array.from(new Set(all));
  } catch {
    return [];
  }
}

/**
 * Build the env block for the spawned KodaX process: isolate HOME, pass
 * provider key, set variant-forcing flags, otherwise inherit (PATH etc).
 */
function buildSpawnEnv(opts: {
  isolatedHome: string;
  alias: ModelAlias;
  variant: EvalVariant;
  extraEnv?: Readonly<Record<string, string>>;
}): NodeJS.ProcessEnv {
  const provider = providerEnv(opts.alias);
  return {
    ...process.env,
    HOME: opts.isolatedHome,
    USERPROFILE: opts.isolatedHome,
    [provider.name]: provider.value,
    ...variantEnv(opts.variant),
    KODAX_DISABLE_BANNER: '1',
    // Eval-only experiment overrides (eg compaction trigger sweep). Spread
    // last so caller can intentionally override anything above.
    ...(opts.extraEnv ?? {}),
  };
}

/**
 * Run one (case, alias, variant) cell. Caller is responsible for
 * orchestrating across cells (see h2-boundary-runner.ts). All filesystem
 * effects of the spawned KodaX are confined to:
 *   - the worktree (cwd)
 *   - the isolated HOME (sessions, config)
 * Both are removed in the `finally` block.
 */
export async function runAgentTaskInWorktree(
  input: AgentTaskInput,
): Promise<AgentTaskResult> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const repoRoot = input.repoRoot ?? process.cwd();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const handle = await setupWorktree({
    id: input.caseId,
    sha: input.gitHeadSha,
    repoRoot,
    seedNodeModules: input.seedNodeModules ?? false,
  });
  // Isolated HOME: a sibling temp dir to the worktree.
  const isolatedHome = `${handle.path}.home`;
  await fs.mkdir(path.join(isolatedHome, '.kodax', 'sessions'), {
    recursive: true,
  });

  const target = resolveAlias(input.alias);
  const taskArgs = [
    '-p',
    input.userMessage,
    '--provider',
    target.provider,
    '--model',
    target.model,
  ];
  const command = input.binOverride?.command ?? 'kodax';
  const prefixArgs = input.binOverride?.args ?? [];
  const args = [...prefixArgs, ...taskArgs];

  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  let timedOut = false;
  const startedAt = Date.now();

  try {
    await new Promise<void>((resolve) => {
      // Windows-only: shell:true for PATH-resolved `.cmd`/`.bat` shims (the
      // global `kodax` install is a `.cmd` wrapper). When the caller passed
      // an absolute `binOverride.command` like 'node', shell is unnecessary
      // — and avoiding shell sidesteps Node 22's DEP0190 deprecation warning
      // about array args + shell:true.
      const needsShell =
        process.platform === 'win32' && !input.binOverride;
      const child = spawn(command, args, {
        cwd: handle.path,
        env: buildSpawnEnv({
          isolatedHome,
          alias: input.alias,
          variant: input.variant,
          extraEnv: input.extraEnv,
        }),
        shell: needsShell,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (d) => {
        stdout += d.toString('utf8');
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8');
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        exitCode = code;
        resolve();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        stderr += `\n[spawn error] ${err.message}`;
        exitCode = -1;
        resolve();
      });
    });

    const durationMs = Date.now() - startedAt;
    const sessionsDir = path.join(isolatedHome, '.kodax', 'sessions');
    const sessionJsonlPath = await findEvalSessionJsonl(sessionsDir);
    const filesChanged = await listFilesChangedInWorktree(handle);

    return {
      caseId: input.caseId,
      alias: input.alias,
      variant: input.variant,
      exitCode,
      processOk: exitCode === 0,
      timedOut,
      durationMs,
      sessionJsonlPath,
      filesChanged,
      stdoutTail: tail(stdout, TAIL_BYTES),
      stderrTail: tail(stderr, TAIL_BYTES),
    };
  } finally {
    // Move sessionJsonl out of isolatedHome before nuking, so caller can
    // still read it via the returned path. Caller can persist if needed.
    // For now we leak the isolated home until caller calls
    // `cleanupAgentTaskArtifacts(result)`. That deferred cleanup keeps the
    // session jsonl readable post-call.
    await cleanupWorktree(handle, { repoRoot }).catch(() => undefined);
    // isolatedHome intentionally NOT removed here — see note above.
  }
}

/**
 * Companion cleanup for `runAgentTaskInWorktree`. Caller invokes after
 * persisting whatever they need from `result.sessionJsonlPath`. Idempotent.
 */
export async function cleanupAgentTaskArtifacts(
  result: AgentTaskResult,
): Promise<void> {
  if (!result.sessionJsonlPath) return;
  const isolatedHome = path.dirname(
    path.dirname(path.dirname(result.sessionJsonlPath)),
  );
  await fs.rm(isolatedHome, { recursive: true, force: true }).catch(
    () => undefined,
  );
}
