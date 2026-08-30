/**
 * KodaX Worktree Isolation Tools
 *
 * Creates and removes git worktrees for isolated agent work.
 */

import { spawn } from 'child_process';
import { mkdirSync, realpathSync, statSync } from 'fs';
import path from 'path';
import {
  containWindowsEffectProcess,
  emitKodaXDiagnostic,
  killChildProcessTree,
  prepareJavaScriptChildLaunch,
  registerManagedChildProcess,
  terminateWindowsEffectJob,
  type WindowsEffectJob,
} from '@kodax-ai/agent';
import type { KodaXToolExecutionContext } from '../types.js';
import {
  isAgentHomeHardMutationTarget,
  isAgentHomeHardRemovalTarget,
} from '../permissions/agent-home-policy.js';
import {
  withPathMutation,
  scheduleUnrefBackgroundRetry,
} from './_internal/file-mutation-queue.js';

const POSIX_GIT_GATE = 'IFS= read -r gate && [ "$gate" = go ] && exec "$KODAX_GIT_EXECUTABLE" "$@"';
const WINDOWS_GIT_GATE = [
  "const readline=require('node:readline')",
  "const {spawn}=require('node:child_process')",
  "const input=readline.createInterface({input:process.stdin,terminal:false})",
  "input.once('line',(gate)=>{",
  "input.close()",
  "if(gate!=='go'){process.exit(125);return}",
  "const args=JSON.parse(process.env.KODAX_GIT_ARGS_JSON||'[]')",
  "const child=spawn(process.env.KODAX_GIT_EXECUTABLE,args,{stdio:'inherit',shell:false,windowsHide:true})",
  "child.once('error',(error)=>{process.stderr.write(String(error&&error.message||error));process.exitCode=1})",
  "child.once('close',(code)=>setTimeout(()=>process.exit(Number.isInteger(code)?code:1),150))",
  "})",
].join(';');
const GIT_HARDENING_ARGS = [
  '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
  '-c', 'core.fsmonitor=false',
  '-c', 'credential.helper=',
  '-c', 'submodule.recurse=false',
] as const;
const GIT_EFFECT_DRAIN_RETRY_MS = 250;
const GIT_EFFECT_DRAIN_MAX_ATTEMPTS = 4;

function resolveGitExecutable(): string {
  const executable = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const entry of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
    if (!entry.trim()) continue;
    const candidate = path.resolve(entry.replace(/^"|"$/g, ''), executable);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue to the next explicit PATH directory.
    }
  }
  throw new Error('A trusted Git executable was not found in PATH.');
}

function gatedGitInvocation(args: readonly string[]): {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
} {
  const hardenedArgs = [...GIT_HARDENING_ARGS, ...args];
  const env = {
    ...process.env,
    KODAX_GIT_ARGS_JSON: JSON.stringify(hardenedArgs),
    KODAX_GIT_EXECUTABLE: resolveGitExecutable(),
  };
  if (process.platform !== 'win32') {
    return {
        executable: '/bin/sh',
        args: ['-c', POSIX_GIT_GATE, 'kodax-worktree-git', ...hardenedArgs],
        env,
    };
  }
  const launch = prepareJavaScriptChildLaunch({
    args: ['-e', WINDOWS_GIT_GATE],
    env,
    isElectron: process.versions.electron !== undefined,
  });
  return { executable: launch.command, args: launch.args, env: launch.env };
}

function execGitFile(
  args: readonly string[],
  cwd: string,
  allowedExitCodes: readonly number[] = [0],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    let binding = Promise.resolve();
    let unregister = (): void => {};
    let abandoned = false;
    let stdout = '';
    let stderr = '';
    let spawnError: Error | undefined;
    let windowsEffectJob: WindowsEffectJob | undefined;
    let drainRecoveryScheduled = false;
    const scheduleDrainRecovery = (): void => {
      if (drainRecoveryScheduled) return;
      drainRecoveryScheduled = true;
      scheduleUnrefBackgroundRetry(
        async () => {
          if (windowsEffectJob !== undefined) {
            await terminateWindowsEffectJob(windowsEffectJob.jobName);
          } else {
            const result = await killChildProcessTree(child);
            if (result.status === 'unknown') {
              throw new Error('Git process tree is still not proven drained.');
            }
          }
          unregister();
        },
        () => undefined,
        (error, attempt) => {
          if (attempt % 10 !== 0) return;
          emitKodaXDiagnostic({
            source: 'coding:worktree-filesystem-effect',
            level: 'warn',
            message: 'Automatic Git process-tree drain recovery is still pending.',
            detail: error,
          });
        },
      );
    };
    const waitForEffectDrain = async (): Promise<void> => {
      if (windowsEffectJob !== undefined) {
        // A rejected Job proof cannot be replaced by a root-only process check.
        // Propagate it and keep terminating the managed tree in the background;
        // Git's own repository locks remain the cross-process authority.
        try {
          await windowsEffectJob.drained;
          unregister();
          return;
        } catch (error: unknown) {
          scheduleDrainRecovery();
          throw error;
        }
      }
      let reportedDrainFailure = false;
      for (let attempt = 1; attempt <= GIT_EFFECT_DRAIN_MAX_ATTEMPTS; attempt += 1) {
        try {
          const result = await killChildProcessTree(child);
          if (result.status !== 'unknown') {
            unregister();
            return;
          }
        } catch (error: unknown) {
          if (!reportedDrainFailure) {
            reportedDrainFailure = true;
            emitKodaXDiagnostic({
              source: 'coding:worktree-filesystem-effect',
              level: 'warn',
              message: 'Git process-tree drain failed; the target worktree state is uncertain.',
              detail: error,
            });
          }
        }
        if (attempt < GIT_EFFECT_DRAIN_MAX_ATTEMPTS) {
          await new Promise<void>((resolve) => setTimeout(resolve, GIT_EFFECT_DRAIN_RETRY_MS));
        }
      }
      if (!reportedDrainFailure) {
        emitKodaXDiagnostic({
          source: 'coding:worktree-filesystem-effect',
          level: 'warn',
          message: 'Git process-tree drain remained unknown; automatic cleanup remains pending.',
        });
      }
      scheduleDrainRecovery();
      throw new Error('Git process tree has not been proven drained.');
    };
    const invocation = gatedGitInvocation(args);
    const child = spawn(invocation.executable, [...invocation.args], {
      cwd,
      detached: process.platform !== 'win32',
      env: invocation.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code) => {
      if (abandoned) return;
      void binding.then(async () => {
        // Repository-controlled launch surfaces are disabled below (hooks,
        // fsmonitor, credential helpers, submodule recursion, and configured
        // content filters). The remaining Git process tree is trusted host
        // plumbing, so root closure is its effect-completion boundary.
        await waitForEffectDrain();
        if (spawnError) {
          reject(spawnError);
        } else if (code === null || !allowedExitCodes.includes(code)) {
          reject(new Error(stderr.trim() || `git ${args.join(' ')} exited with code ${String(code)}`));
        } else {
          resolve({ stdout, stderr });
        }
      }).catch(reject);
    });
    try {
      unregister = registerManagedChildProcess(child, {
        kind: 'worktree-git',
        command: `git ${args.join(' ')}`,
        cwd,
      }, { manualUnregister: true, requireDurableRecord: true });
    } catch (error) {
      abandoned = true;
      void killChildProcessTree(child).then((result) => {
        if (result.status === 'unknown') scheduleDrainRecovery();
      }).catch((terminationError: unknown) => {
        emitKodaXDiagnostic({
          source: 'coding:worktree-filesystem-effect',
          level: 'warn',
          message: 'Git cleanup failed after durable child registration was rejected.',
          detail: terminationError,
        });
        scheduleDrainRecovery();
      });
      reject(error);
      return;
    }
    if (child.pid === undefined || child.stdin === null) {
      abandoned = true;
      const failure = new Error('Git gate did not expose a managed process and stdin.');
      void killChildProcessTree(child).then((result) => {
        if (result.status === 'unknown') scheduleDrainRecovery();
        else unregister();
      }).catch((terminationError: unknown) => {
        emitKodaXDiagnostic({
          source: 'coding:worktree-filesystem-effect',
          level: 'warn',
          message: 'Git gate cleanup failed before process binding completed.',
          detail: terminationError,
        });
        scheduleDrainRecovery();
      });
      reject(failure);
    } else {
      binding = (async () => {
        if (process.platform === 'win32') {
          windowsEffectJob = await containWindowsEffectProcess(child.pid!);
        }
        child.stdin!.end('go\n');
      })().catch(async (error: unknown) => {
        let drainProven = false;
        let terminationFailure: unknown;
        try {
          drainProven = (await killChildProcessTree(child)).status !== 'unknown';
        } catch (caught: unknown) {
          terminationFailure = caught;
        }
        if (windowsEffectJob !== undefined) {
          try {
            await terminateWindowsEffectJob(windowsEffectJob.jobName);
            drainProven = true;
          } catch (caught: unknown) {
            terminationFailure = terminationFailure === undefined
              ? caught
              : new AggregateError(
                  [terminationFailure, caught],
                  'Git root termination and bounded Windows Job termination both failed.',
                );
          }
        }
        if (drainProven) unregister();
        else scheduleDrainRecovery();
        const failure = terminationFailure === undefined
          ? error
          : new AggregateError(
              [error, terminationFailure],
              'Git launch binding and process-tree cleanup both failed.',
            );
        abandoned = true;
        reject(failure);
        throw failure;
      });
      void binding.catch(() => undefined);
    }
  });
}

/**
 * Generate a branch name from description or timestamp.
 */
function generateBranchName(description?: string): string {
  if (description) {
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    return `kodax-wt-${slug}`;
  }
  return `kodax-wt-${Date.now()}`;
}

/**
 * Validate branch name according to git rules.
 */
function isValidBranchName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,62}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/.test(name);
}

/**
 * Creates a new git worktree with an isolated branch.
 *
 * Usage:
 *   {
 *     "branch_name": "feature-xyz",  // optional: explicit branch name
 *     "description": "Add new feature",  // optional: auto-generate branch name from description
 *   }
 *
 * Returns:
 *   {
 *     "path": "/absolute/path/to/worktree",
 *     "branch": "kodax-wt-feature-xyz"
 *   }
 */
export async function toolWorktreeCreate(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  return createWorktree(input, ctx);
}

/** Trusted controller seam; the model-facing handler cannot choose this base. */
export async function createWorkflowWorktree(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (!ctx.workflowWorktreeBaseDir) {
    throw new Error('workflowWorktreeBaseDir is required for controller-owned worktrees');
  }
  return createWorktree(input, ctx, ctx.workflowWorktreeBaseDir);
}

async function createWorktree(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
  trustedBaseDir?: string,
): Promise<string> {
  const branchName = input.branch_name as string | undefined;
  const description = input.description as string | undefined;

  const branch = branchName ?? generateBranchName(description);

  if (!isValidBranchName(branch)) {
    throw new Error(
      `Invalid branch name: ${branch}. Must start and end with alphanumeric, ` +
      `contain only alphanumeric, dots, dashes, or slashes (max 64 chars).`,
    );
  }

  // SECURITY: Reject path traversal sequences in branch names.
  // The regex allows `/` and `.` for hierarchical branch names (e.g. "feat/xyz"),
  // but `..` components could escape the target directory.
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}. Path traversal sequences (..) are not allowed.`);
  }

  const cwd = ctx.executionCwd ?? ctx.gitRoot ?? process.cwd();

  // A trusted workflow may provide `<runDir>/worktrees` through its execution
  // context. Otherwise use a sibling of the repo because a worktree cannot nest
  // inside the main working tree.
  const explicitBaseDir = trustedBaseDir
    ? path.resolve(trustedBaseDir)
    : undefined;
  const baseDir = explicitBaseDir ?? path.resolve(cwd, '..');
  const worktreePath = path.resolve(baseDir, `.kodax-worktree-${branch}`);

  // Verify the resolved path stays within the expected parent directory
  if (!worktreePath.startsWith(baseDir)) {
    throw new Error(`Worktree path escaped expected directory. Resolved to: ${worktreePath}`);
  }
  return withPathMutation(
    worktreePath,
    async () => {
      if (!explicitBaseDir && isAgentHomeHardMutationTarget(worktreePath, cwd)) {
        throw new Error(`Worktree path targets protected KodaX state: ${worktreePath}`);
      }

      // `git worktree add` creates the leaf dir but not missing parents. An
      // explicit base (e.g. a fresh `<runDir>/worktrees`) may not exist yet; the
      // default sibling-of-repo base always does.
      if (explicitBaseDir) {
        mkdirSync(explicitBaseDir, { recursive: true });
      }

      let worktreeCreated = false;
      try {
        const configuredFilters = await execGitFile(
          ['config', '--local', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'],
          cwd,
          [0, 1],
        );
        if (configuredFilters.stdout.trim()) {
          throw new Error('repository-configured content filter processes are not allowed');
        }
        await execGitFile(
          ['worktree', 'add', '-b', branch, worktreePath],
          cwd,
        );
        worktreeCreated = true;
        await ctx.workspaceSandboxRoots?.register(worktreePath);
      } catch (error) {
        const failures: unknown[] = [error];
        if (worktreeCreated) {
          try {
            await execGitFile(
              ['worktree', 'remove', worktreePath, '--force'],
              cwd,
            );
          } catch (rollbackError: unknown) {
            failures.push(rollbackError);
          }
          try {
            await execGitFile(
              ['branch', '-D', branch],
              cwd,
            );
          } catch (rollbackError: unknown) {
            failures.push(rollbackError);
          }
        }
        const failure = failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'Worktree registration rollback failed.');
        const message = failure instanceof Error ? failure.message : String(failure);
        throw new Error(`Failed to create worktree: ${message}`, { cause: failure });
      }

      return JSON.stringify({ path: worktreePath, branch });
    },
  );
}

/**
 * Removes a git worktree and optionally its branch.
 *
 * Usage:
 *   {
 *     "action": "keep",              // "keep" | "remove"
 *     "worktree_path": "/path/to/worktree",  // absolute path to the worktree
 *     "discard_changes": false       // optional: force removal even with uncommitted changes
 *   }
 *
 * Returns:
 *   {
 *     "restored": true,
 *     "message": "Worktree removed. ..."
 *   }
 */
export async function toolWorktreeRemove(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  return removeWorktree(input, ctx);
}

/** Trusted counterpart for reclaiming a controller-owned workflow worktree. */
export async function removeWorkflowWorktree(
  worktreePath: string,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (!ctx.workflowWorktreeBaseDir) {
    throw new Error('workflowWorktreeBaseDir is required for controller-owned worktrees');
  }
  return removeWorktree({
    action: 'remove',
    worktree_path: worktreePath,
    discard_changes: false,
  }, ctx, ctx.workflowWorktreeBaseDir);
}

async function removeWorktree(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
  trustedBaseDir?: string,
): Promise<string> {
  const action = input.action as string | undefined;
  const worktreePath = input.worktree_path as string | undefined;
  const discardChanges = input.discard_changes as boolean | undefined;

  if (!action || (action !== 'keep' && action !== 'remove')) {
    throw new Error('action must be "keep" or "remove"');
  }

  if (!worktreePath) {
    throw new Error('worktree_path is required');
  }

  const cwd = ctx.executionCwd ?? ctx.gitRoot ?? process.cwd();

  if (action === 'keep') {
    return JSON.stringify({
      restored: true,
      message: `Worktree kept at ${worktreePath}. Restored CWD.`,
    });
  }
  const trustedTarget = trustedBaseDir !== undefined
    && isPathWithin(worktreePath, path.resolve(trustedBaseDir));
  return withPathMutation(
    path.resolve(worktreePath),
    async () => {
      if (!trustedTarget && isAgentHomeHardRemovalTarget(worktreePath, cwd)) {
        throw new Error(`Worktree removal targets protected KodaX state: ${worktreePath}`);
      }

      // Safety check: count uncommitted changes
      if (!discardChanges) {
        try {
          const { stdout: statusOut } = await execGitFile(
            ['status', '--porcelain'],
            worktreePath,
          );
          const uncommittedFiles = statusOut
            .trim()
            .split('\n')
            .filter((line) => line.trim().length > 0).length;
          const { stdout: revListOut } = await execGitFile(
            ['rev-list', '--count', 'HEAD', '--not', '--remotes'],
            worktreePath,
          );
          const localCommits = parseInt(revListOut.trim(), 10) || 0;

          if (uncommittedFiles > 0 || localCommits > 0) {
            throw new Error(
              `Worktree has ${uncommittedFiles} uncommitted file(s) and ${localCommits} local commit(s). `
              + 'Use discard_changes=true to force removal, or commit/push your work first.',
            );
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.message.includes('uncommitted')) throw error;
          throw new Error(
            `Cannot verify worktree state: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      let branch = '';
      try {
        const { stdout: branchOut } = await execGitFile(
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          worktreePath,
        );
        branch = branchOut.trim();
      } catch {
        // If we cannot identify the branch, removal may still safely proceed.
      }

      let sandboxRootToRevoke: string | undefined;
      if (ctx.workspaceSandboxRoots !== undefined) {
        const requestedRoot = path.resolve(worktreePath);
        let canonicalRoot = requestedRoot;
        try {
          canonicalRoot = realpathSync.native(requestedRoot);
        } catch {
          // A missing pre-correction root may still have stale Git metadata
          // that `git worktree remove --force` can clean up.
        }
        sandboxRootToRevoke = ctx.workspaceSandboxRoots.list().find((root) => (
          sameHostPath(root, canonicalRoot) || sameHostPath(root, requestedRoot)
        ));
      }

      try {
        await execGitFile(
          ['worktree', 'remove', worktreePath, '--force'],
          cwd,
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to remove worktree: ${message}`);
      }

      if (branch) {
        try {
          await execGitFile(
            ['branch', '-D', branch],
            cwd,
          );
        } catch {
          // The branch may not exist or may be checked out elsewhere.
        }
      }

      if (sandboxRootToRevoke !== undefined) {
        await ctx.workspaceSandboxRoots?.unregister(sandboxRootToRevoke);
      }

      return JSON.stringify({
        restored: true,
        message: `Worktree removed. Branch ${branch || '(unknown)'} deleted. Restored CWD.`,
      });
    },
  );
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameHostPath(left: string, right: string): boolean {
  const comparable = (value: string): string => {
    const resolved = path.normalize(path.resolve(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return comparable(left) === comparable(right);
}
