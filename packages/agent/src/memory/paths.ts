/**
 * FEATURE_124 (v0.7.43) — Memory System Alignment: path resolver.
 *
 * Per-project isolated memory directory under
 * `<agentConfigHome>/projects/<sanitized-project-key>/memory/`. Mirrors
 * claudecode `src/memdir/paths.ts` per-project layout so the same repo
 * gets the same memory directory across worktrees / machines.
 *
 * Resolution order:
 *   1. `git config --get remote.origin.url` (when present) — stable across
 *      worktrees + clones. (claudecode keys by the canonical local git root
 *      instead; a remote also joins clones on different machines.)
 *   2. `local-<sha256(cwd)>` fallback — for repos without a remote, or
 *      when git is unavailable. Stable within a single clone path.
 *
 * Reuses `getAgentConfigPath('projects', key, 'memory')` from
 * `runtime/agent-home.ts` (v0.7.35.1 FEATURE_145) so substrate consumers
 * who override `setAgentConfigHome()` automatically get a fresh memory
 * directory tree under their override root.
 */

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { assertNoGitInstallPromptSync } from '../runtime/macos-git.js';
import * as path from 'node:path';

import { getAgentConfigPath } from '../runtime/agent-home.js';
import {
  hashMemoryIdentityComponent,
  matchesMemoryApplicability,
  type MemoryContextIdentity,
} from './identity.js';

export { hashMemoryIdentityComponent, matchesMemoryApplicability } from './identity.js';

/**
 * Sanitize a git remote URL to a filesystem-safe project key.
 *
 * Strips protocol / SSH user prefix, lowercases host, replaces `:`, `@`,
 * `/` with `-`, drops trailing `.git`. The result is deterministic and
 * collision-free for distinct repos (different host or path → different
 * key) and stable across clones of the same repo (same remote → same key).
 *
 * Examples:
 *   `https://github.com/user/repo.git`         → `github.com-user-repo`
 *   `git@github.com:user/repo.git`             → `github.com-user-repo`
 *   `ssh://git@gitlab.example.com/team/repo`   → `gitlab.example.com-team-repo`
 *
 * Note: hosts `github.com` over HTTPS and `git@github.com:` over SSH
 * intentionally produce the same key — they identify the same repo,
 * just different access protocols.
 */
export function sanitizeProjectKey(remoteUrl: string): string {
  return remoteWithoutCredentials(remoteUrl)
    .trim()
    .replace(/^ssh:\/\//, '')
    .replace(/^https?:\/\//, '')
    .replace(/^git@/, '')
    .replace(/\.git$/, '')
    .replace(/[:@/\\]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function remoteWithoutCredentials(remoteUrl: string): string {
  const value = remoteUrl.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}${parsed.port.length > 0 ? `:${parsed.port}` : ''}${parsed.pathname}`;
  } catch {
    return value
      .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, '$1')
      .replace(/[?#].*$/, '');
  }
}

/**
 * SHA-256 hash of an absolute cwd, truncated to 16 hex chars. Used as
 * the project key fallback when `git config --get remote.origin.url`
 * returns nothing.
 *
 * Path is normalized + lowercased before hashing so case-insensitive
 * filesystems (macOS default, Windows) produce the same key for
 * `/Users/X/repo` and `/users/x/repo`.
 */
export function hashCwd(cwd: string): string {
  const normalized = path.resolve(cwd).toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Read `git config --get remote.origin.url` from the given cwd. Returns
 * `undefined` on any failure (no git installed / not a repo / no remote
 * configured / git timed out). NEVER throws.
 *
 * 1000ms timeout — guards against pathological git hangs on broken
 * .git/config without blocking session startup.
 */
export function tryGitRemote(cwd: string): string | undefined {
  try {
    assertNoGitInstallPromptSync({ cwd });
    const stdout = execSync('git config --get remote.origin.url', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
      windowsHide: true,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The main checkout's root for any directory inside a git repository: a
 * subdirectory or a linked worktree of it gives the same answer. Returns
 * `undefined` outside a repository or when git fails. NEVER throws.
 */
export function tryGitProjectRoot(cwd: string): string | undefined {
  try {
    assertNoGitInstallPromptSync({ cwd });
    const [top, common] = execSync('git rev-parse --show-toplevel --git-common-dir', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
      windowsHide: true,
    }).split(/\r?\n/);
    if (top === undefined || top.trim().length === 0) return undefined;
    const commonDir = common === undefined || common.length === 0 ? undefined : path.resolve(cwd, common);
    // A linked worktree keeps its git data in the main checkout's .git directory. Anything
    // else (a submodule, a bare repository, a git too old to know the flag) keeps its own top.
    return commonDir !== undefined && path.basename(commonDir) === '.git' && fs.existsSync(commonDir)
      ? path.dirname(commonDir)
      : path.resolve(top);
  } catch {
    return undefined;
  }
}

/**
 * The key a project's FEATURE_308 notes live under: the sanitized remote, or
 * for a repository without one, a hash of its main checkout's root, so every
 * subdirectory and worktree shares one store. The legacy memory directory
 * keeps its cwd key (`resolveMemoryRoot`), since memories already on disk are found by it.
 */
export function resolveProjectKey(cwd: string): string {
  const remote = tryGitRemote(cwd);
  return remote ? sanitizeProjectKey(remote) : `local-${hashCwd(tryGitProjectRoot(cwd) ?? cwd)}`;
}

/**
 * Resolve the memory directory for the given cwd.
 *
 * `<agentConfigHome>/projects/<key>/memory/` where key is:
 *   - sanitized git remote URL when available
 *   - `local-<sha256(cwd)[:16]>` fallback otherwise
 */
export function resolveMemoryRoot(cwd: string): string {
  const remote = tryGitRemote(cwd);
  const key = remote ? sanitizeProjectKey(remote) : `local-${hashCwd(cwd)}`;
  return getAgentConfigPath('projects', key, 'memory');
}

/**
 * Path of the MEMORY.md index file inside a resolved memory root.
 */
export function resolveMemoryEntrypoint(cwd: string): string {
  return path.join(resolveMemoryRoot(cwd), 'MEMORY.md');
}

export type DurableMemoryScope = 'project' | 'workspace' | 'agent' | 'user';

export function resolveScopedMemoryRoot(
  identity: MemoryContextIdentity,
  scope: DurableMemoryScope,
): string {
  const field = scope === 'project'
    ? 'projectId'
    : scope === 'workspace'
      ? 'workspaceId'
      : scope === 'user'
        ? 'userId'
        : 'agentId';
  const canonicalId = identity[field];
  if (canonicalId === undefined || canonicalId.length === 0) {
    throw new Error(`${field} is required for ${scope} memory`);
  }
  const segments = [
    'memory-scopes',
    hashMemoryIdentityComponent('tenant', identity.tenantId),
    scope,
    hashMemoryIdentityComponent(scope, canonicalId),
  ];
  return identity.configHome === undefined
    ? getAgentConfigPath(...segments)
    : path.join(identity.configHome, ...segments);
}

/**
 * Check whether a given absolute path is inside ANY memory directory
 * (under `<agentConfigHome>/projects/*​/memory/`). Used by the REPL
 * transcript renderer to badge memory writes / reads, and by future
 * tool-permission carve-outs.
 *
 * Returns true for every file inside a governed scoped root or a legacy
 * `projects/<key>/memory/` directory. This includes governance sidecars;
 * path traversal (`..`) is normalized before the check.
 *
 * The check is path-prefix only — it does NOT verify the file exists
 * on disk. A planned write to `<memoryRoot>/feedback_X.md` returns true
 * even before the file is created.
 */
export function isAutoManagedMemoryFile(filePath: string): boolean {
  const normalized = comparablePath(filePath);
  const scopedRoot = comparablePath(getAgentConfigPath('memory-scopes'));
  if (normalized.startsWith(scopedRoot + path.sep)) {
    const segments = normalized.slice(scopedRoot.length + 1).split(path.sep);
    return segments.length >= 4
      && /^[0-9a-f]{64}$/.test(segments[0] ?? '')
      && ['project', 'workspace', 'agent', 'user'].includes(segments[1] ?? '')
      && /^[0-9a-f]{64}$/.test(segments[2] ?? '');
  }
  // FEATURE_308 user-scope note store: <agentConfigHome>/notes/<file>.md
  if (normalized.startsWith(comparablePath(getAgentConfigPath('notes')) + path.sep)) return true;
  const projectsRoot = comparablePath(getAgentConfigPath('projects'));
  if (!normalized.startsWith(projectsRoot + path.sep)) return false;
  // Path under projects/ must include a /memory/ (or FEATURE_308 /notes/) segment,
  // ruling out sibling directories like projects/<key>/sessions/.
  const tail = normalized.slice(projectsRoot.length + 1);
  const segments = tail.split(path.sep);
  // Expect: <key>/memory/<file>.md  or  <key>/memory/<subdir>/<file>.md
  return segments.length >= 3 && (segments[1] === 'memory' || segments[1] === 'notes');
}

function comparablePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Best-effort filename-based type guess for badge rendering. Mirrors the
 * 4-type taxonomy: `feedback_*.md` → `feedback`, etc. Returns `undefined`
 * for filenames that don't follow the convention — UI should fall back
 * to reading frontmatter or showing a generic `[memory]` badge.
 *
 * This is a HEURISTIC for cheap UI display. Authoritative type lives in
 * the file's YAML frontmatter (see `frontmatter.ts`).
 */
export function parseMemoryTypeFromFilename(
  filePath: string,
): 'user' | 'feedback' | 'project' | 'reference' | undefined {
  const base = path.basename(filePath, '.md').toLowerCase();
  if (base.startsWith('user_') || base === 'user') return 'user';
  if (base.startsWith('feedback_') || base === 'feedback') return 'feedback';
  if (base.startsWith('project_') || base === 'project') return 'project';
  if (base.startsWith('reference_') || base === 'reference') return 'reference';
  return undefined;
}
