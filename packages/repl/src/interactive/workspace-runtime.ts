import { execFile as execFileCallback } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { KodaXSessionData, KodaXSessionRuntimeInfo, KodaXSessionWorkspaceKind } from '@kodax-ai/agent';
import { assertNoGitInstallPrompt } from '@kodax-ai/agent/runtime/macos-git';

const execFileAsync = promisify(execFileCallback);

function normalizePath(value: string | undefined | null): string | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }

  return path.resolve(value).replace(/\\/g, '/');
}

async function gitStdout(
  cwd: string,
  args: string[],
  timeout = 5_000,
): Promise<string | undefined> {
  try {
    await assertNoGitInstallPrompt({ cwd });
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout,
    });
    const trimmed = stdout.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function filesystemWorkspaceIdentity(cwd: string): {
  readonly canonicalRoot: string;
  readonly workspaceRoot: string;
} | undefined {
  let current = path.resolve(cwd);
  while (true) {
    const dotGit = path.join(current, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) {
        const root = normalizePath(current) ?? current.replace(/\\/g, '/');
        return { canonicalRoot: root, workspaceRoot: root };
      }
      if (stat.isFile()) {
        const match = /^gitdir:\s*(.+)$/im.exec(fs.readFileSync(dotGit, 'utf8'));
        if (match?.[1]) {
          const gitDir = path.resolve(current, match[1].trim());
          let commonDir: string | undefined;
          try {
            commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
          } catch {
            // A submodule-style .git file has no separate common-dir identity.
          }
          const workspaceRoot = normalizePath(current) ?? current.replace(/\\/g, '/');
          return {
            canonicalRoot: deriveCanonicalRepoRoot(commonDir) ?? workspaceRoot,
            workspaceRoot,
          };
        }
      }
    } catch {
      // Keep walking until the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function comparablePath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
}

/** Discover only the linked worktrees recorded by this repository's common Git directory. */
export function discoverLinkedWorkspaceRoots(canonicalRoot: string): string[] {
  const worktreesDir = path.join(path.resolve(canonicalRoot), '.git', 'worktrees');
  let entries: import('fs').Dirent[];
  try {
    entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const expectedCanonicalRoot = comparablePath(canonicalRoot);
  return entries.flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    try {
      const metadataDir = path.join(worktreesDir, entry.name);
      const gitDirValue = fs.readFileSync(path.join(metadataDir, 'gitdir'), 'utf8').trim();
      if (!gitDirValue) return [];
      const gitDir = path.isAbsolute(gitDirValue)
        ? gitDirValue
        : path.resolve(metadataDir, gitDirValue);
      const workspaceRoot = path.dirname(gitDir);
      const identity = filesystemWorkspaceIdentity(workspaceRoot);
      return identity !== undefined
        && comparablePath(identity.canonicalRoot) === expectedCanonicalRoot
        ? [identity.workspaceRoot]
        : [];
    } catch {
      // Stale linked-worktree metadata is ignored; Git itself leaves these records behind.
      return [];
    }
  });
}

function parseProjectIdentityOutput(stdout: string | undefined): {
  readonly canonicalRoot: string;
  readonly workspaceRoot: string;
} | undefined {
  const [workspaceLine, commonLine] = stdout?.split(/\r?\n/).map((line) => line.trim()) ?? [];
  const workspaceRoot = normalizePath(workspaceLine);
  if (!workspaceRoot) return undefined;
  const commonDir = commonLine
    ? normalizePath(path.isAbsolute(commonLine) ? commonLine : path.resolve(workspaceRoot, commonLine))
    : undefined;
  return {
    canonicalRoot: deriveCanonicalRepoRoot(commonDir) ?? workspaceRoot,
    workspaceRoot,
  };
}

export async function resolveWorkspaceProjectIdentity(options: {
  cwd?: string;
  timeoutMs?: number;
} = {}): Promise<{ readonly canonicalRoot: string; readonly workspaceRoot: string }> {
  const executionCwd = normalizePath(options.cwd ?? process.cwd()) ?? process.cwd().replace(/\\/g, '/');
  const filesystemIdentity = filesystemWorkspaceIdentity(executionCwd);
  if (filesystemIdentity !== undefined) return filesystemIdentity;
  const inspected = parseProjectIdentityOutput(await gitStdout(
    executionCwd,
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
    options.timeoutMs ?? 2_000,
  ));
  return inspected
    ?? { canonicalRoot: executionCwd, workspaceRoot: executionCwd };
}

export async function resolveCanonicalWorkspaceRoot(options: {
  cwd?: string;
  timeoutMs?: number;
} = {}): Promise<string> {
  return (await resolveWorkspaceProjectIdentity(options)).canonicalRoot;
}

function deriveCanonicalRepoRoot(commonDir: string | undefined): string | undefined {
  const normalized = normalizePath(commonDir);
  if (!normalized) {
    return undefined;
  }

  return path.posix.basename(normalized) === '.git'
    ? path.posix.dirname(normalized)
    : normalized;
}

export async function inspectWorkspaceRuntime(options: {
  cwd?: string;
  workspaceKind?: KodaXSessionWorkspaceKind;
} = {}): Promise<KodaXSessionRuntimeInfo> {
  const executionCwd = normalizePath(options.cwd ?? process.cwd()) ?? process.cwd().replace(/\\/g, '/');
  const workspaceRoot = normalizePath(
    await gitStdout(executionCwd, ['rev-parse', '--show-toplevel']),
  );
  const repositoryCwd = workspaceRoot ?? executionCwd;
  const [commonDir, branch] = await Promise.all([
    gitStdout(repositoryCwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      .then((value) => value ?? gitStdout(repositoryCwd, ['rev-parse', '--git-common-dir'])),
    gitStdout(repositoryCwd, ['branch', '--show-current'])
      .then((value) => value ?? gitStdout(repositoryCwd, ['rev-parse', '--abbrev-ref', 'HEAD'])),
  ]);

  return {
    canonicalRepoRoot: deriveCanonicalRepoRoot(commonDir) ?? workspaceRoot,
    workspaceRoot,
    executionCwd,
    branch: branch && branch !== 'HEAD' ? branch : undefined,
    workspaceKind: options.workspaceKind ?? 'detected',
  };
}

export function isSameCanonicalRepo(
  left: KodaXSessionRuntimeInfo | undefined,
  right: KodaXSessionRuntimeInfo | undefined,
): boolean {
  if (!left?.canonicalRepoRoot || !right?.canonicalRepoRoot) {
    return false;
  }

  return normalizePath(left.canonicalRepoRoot) === normalizePath(right.canonicalRepoRoot);
}

export function workspaceExists(runtimeInfo: KodaXSessionRuntimeInfo | undefined): boolean {
  return Boolean(runtimeInfo?.workspaceRoot && fs.existsSync(runtimeInfo.workspaceRoot));
}

export function resolveSessionRuntimeInfo(
  data: Pick<KodaXSessionData, 'gitRoot' | 'runtimeInfo'>,
): KodaXSessionRuntimeInfo | undefined {
  const workspaceRoot = normalizePath(data.runtimeInfo?.workspaceRoot ?? data.gitRoot);
  const executionCwd = normalizePath(data.runtimeInfo?.executionCwd ?? workspaceRoot);
  const canonicalRepoRoot = normalizePath(data.runtimeInfo?.canonicalRepoRoot ?? workspaceRoot);

  if (!workspaceRoot && !executionCwd && !canonicalRepoRoot) {
    return undefined;
  }

  return {
    canonicalRepoRoot,
    workspaceRoot,
    executionCwd,
    branch: data.runtimeInfo?.branch,
    workspaceKind: data.runtimeInfo?.workspaceKind ?? 'detected',
  };
}

export function formatWorkspaceTruth(runtimeInfo: KodaXSessionRuntimeInfo | undefined): string {
  if (!runtimeInfo?.workspaceRoot) {
    return 'No git workspace detected';
  }

  const branch = runtimeInfo.branch ? ` @ ${runtimeInfo.branch}` : '';
  const kind = runtimeInfo.workspaceKind ?? 'detected';
  return `${runtimeInfo.workspaceRoot}${branch} [${kind}]`;
}
