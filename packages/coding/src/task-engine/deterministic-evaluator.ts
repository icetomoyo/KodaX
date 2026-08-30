/**
 * Deterministic per-step evaluator — FEATURE_114 v0.7.36.
 *
 * When a `todo_update` transitions an item from `in_progress` →
 * `completed` and the item carries an `evaluator` hint
 * (`'build' | 'test' | 'lint'`), the runner runs the corresponding
 * deterministic check inside the workspace and threads stderr / exit
 * code into the next tool result. The Worker reads that result on its
 * next turn and self-corrects.
 *
 * Why deterministic only (no LLM-as-judge): Phase 0.7 industry survey
 * showed 4/4 codebases reject per-step LLM verification. The cost
 * (every step doubles the LLM call count) does not justify the
 * marginal precision improvement. KodaX's structural Evaluator
 * (Worker emit_handoff → Evaluator) is the LLM-judge gate; per-step
 * checks are ground-truth probes.
 *
 * Shell timeout / quoting / Windows-vs-POSIX dispatch is delegated to
 * the existing `runShellCommand` substrate so this helper stays a
 * thin policy layer (which command for which hint, plus
 * cwd/timeout/output capture).
 */

import { spawn } from 'child_process';
import { killChildProcessTree, rememberChildProcessTree } from '@kodax-ai/agent';
import {
  appendBashOutputChunk,
  createBashOutputCollector,
  disposeBashOutputCollector,
  finishBashOutputCollector,
  type BashOutputCollector,
} from '../tools/bash-output-collector.js';
import type { KodaXSandboxOptions, KodaXShellExecutionContract } from '../types.js';
import {
  createShellCommandInvocation,
  resolveShellExecution,
} from '../shell-execution/resolver.js';
import {
  hardenShellCommandEnvironment,
} from '../shell-execution/environment.js';

export type DeterministicEvaluatorHint = 'build' | 'test' | 'lint';

export interface DeterministicEvaluatorResult {
  readonly hint: DeterministicEvaluatorHint;
  readonly command: string;
  readonly status: 'pass' | 'fail' | 'skipped' | 'error';
  /** Process exit code; `undefined` when the process did not run. */
  readonly exitCode: number | undefined;
  /** Complete stderr. The historical field name is retained for API compatibility. */
  readonly stderrTail: string;
  /** Complete stdout. The historical field name is retained for API compatibility. */
  readonly stdoutTail: string;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
}

export interface RunDeterministicEvaluatorInput {
  readonly hint: DeterministicEvaluatorHint;
  readonly cwd: string;
  /** Optional host-owned shell policy shared with model-issued command tools. */
  readonly shellExecution?: KodaXShellExecutionContract;
  /** Session scratch identity used to isolate resolved environment cache entries. */
  readonly sessionScratchDir?: string;
  /** Run-scoped command-target environment policy supplied by the SDK host. */
  readonly sandbox?: KodaXSandboxOptions;
  /** Timeout in milliseconds. Default 90 000 (90s). */
  readonly timeoutMs?: number;
  /**
   * Override for the project-level command. Useful for tests that
   * don't have an `npm run build` script or want a custom one-liner
   * — production runs use the default mapping.
   */
  readonly commandOverride?: string;
  /**
   * Optional path scope for `test`. When set, the test command becomes
   * `npx vitest run <scopePath>` instead of the project-level
   * `npm run test`. Used when a todo item targets a specific module.
   */
  readonly testScopePath?: string;
}

const DEFAULT_TIMEOUT_MS = 90_000;

function defaultCommandFor(input: RunDeterministicEvaluatorInput): string {
  if (input.commandOverride && input.commandOverride.trim().length > 0) {
    return input.commandOverride;
  }
  switch (input.hint) {
    case 'build':
      return 'npm run build';
    case 'test':
      return input.testScopePath
        ? `npx vitest run ${input.testScopePath}`
        : 'npm run test --';
    case 'lint':
      return 'npm run lint';
  }
}

interface FinalizedStream {
  readonly text: string;
  readonly error?: string;
}

function finalizeStream(label: 'stdout' | 'stderr', collector: BashOutputCollector): FinalizedStream {
  try {
    return { text: finishBashOutputCollector(collector).toString('utf-8') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: '',
      error: `[deterministic-evaluator] Failed to finalize complete ${label}: ${message}`,
    };
  } finally {
    disposeBashOutputCollector(collector);
  }
}

function appendDiagnostic(output: string, diagnostic: string): string {
  return output.length > 0 ? `${output}\n${diagnostic}` : diagnostic;
}

/**
 * Run a deterministic check for the given hint. Captures complete stderr,
 * complete stdout, and exit code. The `status` summarizes the outcome:
 *
 *  - `'pass'`   — exit code 0
 *  - `'fail'`   — exit code !== 0
 *  - `'skipped'`— command not available (npm script missing); the
 *                 caller treats this as a soft signal — Worker is not
 *                 blamed for a missing build script
 *  - `'error'`  — process failed to spawn or hit the timeout
 */
export async function runDeterministicEvaluator(
  input: RunDeterministicEvaluatorInput,
): Promise<DeterministicEvaluatorResult> {
  const command = defaultCommandFor(input);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const fallbackEnvironmentSource = input.sessionScratchDir === undefined
    ? process.env
    : { ...process.env, KODAX_SESSION_TMP: input.sessionScratchDir };
  const fallbackEnvironment = hardenShellCommandEnvironment(
    fallbackEnvironmentSource,
    process.platform === 'win32' ? 'cmd' : 'bash',
    process.platform,
  );
  let configuredInvocation:
    | ReturnType<typeof createShellCommandInvocation>
    | undefined;
  if (input.shellExecution !== undefined) {
    try {
      const resolved = await resolveShellExecution(
        input.shellExecution,
        input.cwd,
        input.sessionScratchDir,
      );
      configuredInvocation = createShellCommandInvocation(resolved, command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        hint: input.hint,
        command,
        status: 'error',
        exitCode: undefined,
        stderrTail:
          `[deterministic-evaluator] Configured shell environment could not be resolved: ${message}`,
        stdoutTail: '',
        durationMs: Date.now() - startedAt,
      };
    }
  }

  return new Promise<DeterministicEvaluatorResult>((resolve) => {
    const proc = configuredInvocation === undefined
      ? spawn(command, {
          cwd: input.cwd,
          env: fallbackEnvironment,
          shell: true,
          windowsHide: true,
          detached: process.platform !== 'win32',
        })
      : spawn(
          configuredInvocation.executable,
          [...configuredInvocation.args],
          {
            cwd: input.cwd,
            env: configuredInvocation.env,
            shell: false,
            windowsHide: true,
            detached: process.platform !== 'win32',
            ...(configuredInvocation.windowsVerbatimArguments === true
              ? { windowsVerbatimArguments: true }
              : {}),
          },
        );
    rememberChildProcessTree(proc);

    const stdoutCollector = createBashOutputCollector();
    const stderrCollector = createBashOutputCollector();
    let timedOut = false;
    let resolved = false;

    const finalizeOutput = (): { stdout: string; stderr: string; captureFailed: boolean } => {
      const stdout = finalizeStream('stdout', stdoutCollector);
      const stderr = finalizeStream('stderr', stderrCollector);
      const diagnostics = [stdout.error, stderr.error].filter((value): value is string => Boolean(value));
      return {
        stdout: stdout.text,
        stderr: diagnostics.reduce(appendDiagnostic, stderr.text),
        captureFailed: diagnostics.length > 0,
      };
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      void killChildProcessTree(proc);
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer | string) => {
      appendBashOutputChunk(
        stdoutCollector,
        typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk,
      );
    });
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      appendBashOutputChunk(
        stderrCollector,
        typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk,
      );
    });

    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      const output = finalizeOutput();
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        hint: input.hint,
        command,
        status: 'error',
        exitCode: undefined,
        stderrTail: appendDiagnostic(output.stderr, message),
        stdoutTail: output.stdout,
        durationMs: Date.now() - startedAt,
      });
    });

    proc.on('close', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      const output = finalizeOutput();
      const { stdout } = output;
      let { stderr } = output;
      if (timedOut) {
        stderr = appendDiagnostic(
          stderr,
          `[deterministic-evaluator] TIMEOUT after ${timeoutMs}ms (signal=${signal ?? 'SIGTERM'})`,
        );
        resolve({
          hint: input.hint,
          command,
          status: 'error',
          exitCode: code ?? undefined,
          stderrTail: stderr,
          stdoutTail: stdout,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      if (output.captureFailed) {
        resolve({
          hint: input.hint,
          command,
          status: 'error',
          exitCode: code ?? undefined,
          stderrTail: stderr,
          stdoutTail: stdout,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      // Heuristic: `npm run <missing-script>` exits with a non-zero
      // code AND emits "Missing script" or "command not found" — treat
      // as `'skipped'` so the Worker isn't blamed for a missing build
      // step. Conservative match — only when stderr clearly says the
      // script is missing.
      if (
        code !== 0
        && (
          stderr.toLowerCase().includes('missing script')
          || stderr.toLowerCase().includes('command not found')
          || stderr.toLowerCase().includes('not recognized as an internal')
        )
      ) {
        resolve({
          hint: input.hint,
          command,
          status: 'skipped',
          exitCode: code ?? undefined,
          stderrTail: stderr,
          stdoutTail: stdout,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      resolve({
        hint: input.hint,
        command,
        status: code === 0 ? 'pass' : 'fail',
        exitCode: code ?? undefined,
        stderrTail: stderr,
        stdoutTail: stdout,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Format a result for inclusion in a tool-result tail. Used by the
 * Runner when threading evaluator output back into the Worker's
 * transcript.
 */
export function formatDeterministicEvaluatorResult(
  result: DeterministicEvaluatorResult,
): string {
  const header = `[deterministic-evaluator:${result.hint}] ${result.status} (exit=${
    result.exitCode ?? 'n/a'
  }, ${result.durationMs}ms) — \`${result.command}\``;
  const parts = [header];
  if (result.status === 'skipped') {
    parts.push('  Skipped: command not available; not blocking the run.');
  }
  if (result.stdoutTail) {
    parts.push('--- stdout ---', result.stdoutTail);
  }
  if (result.stderrTail) {
    parts.push('--- stderr ---', result.stderrTail);
  }
  return parts.join('\n');
}
