import { execFile as execFileCallback } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { KodaXSessionData, KodaXSessionRuntimeInfo, KodaXSessionWorkspaceKind } from '@kodax/coding';

const execFileAsync = promisify(execFileCallback);

function normalizePath(value: string | undefined | null): string | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }

  return path.resolve(value).replace(/\\/g, '/');
}

async function gitStdout(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const trimmed = stdout.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
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
  const commonDir = await gitStdout(
    workspaceRoot ?? executionCwd,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  ) ?? await gitStdout(
    workspaceRoot ?? executionCwd,
    ['rev-parse', '--git-common-dir'],
  );
  const branch = await gitStdout(workspaceRoot ?? executionCwd, ['branch', '--show-current'])
    ?? await gitStdout(workspaceRoot ?? executionCwd, ['rev-parse', '--abbrev-ref', 'HEAD']);

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
