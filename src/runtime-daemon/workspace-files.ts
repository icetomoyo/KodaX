/**
 * What a client reads of the Host workspace: what a directory holds, the bytes
 * of a file, and what git sees changed in a project. Nothing here writes. A
 * path names a place inside the workspace. One that leads out through a link,
 * or names a secret the way the read tool refuses a remote Agent, is refused.
 */
import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { assertNoGitInstallPrompt } from '@kodax-ai/agent';

import { HostProtocolError } from '../host-protocol/codec.js';
import { isSecretPath, SECRET_DIRECTORIES, SECRET_FILES } from '../secret-paths.js';
import { HOST_BLOB_LIMITS } from './host-blobs.js';
import { within } from './workspace.js';

const LIST_PAGE = 500;
/** A diff stays well inside a frame however its text escapes. */
const MAX_DIFF_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 30_000;

export interface WorkspaceEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'link' | 'other';
  readonly size?: number;
  readonly modifiedAt?: number;
}

const outside = (): HostProtocolError => new HostProtocolError(
  'invalid_params', 'The path must stay inside the Host workspace.', { reason: 'path_outside_workspace' });
const refused = (): HostProtocolError => new HostProtocolError(
  'forbidden', 'This path is unavailable under the read policy.', { reason: 'path_refused' });

/** The real path `at` names in `root`, a real path, once it is checked to be inside and to name no secret. */
async function resolveInside(root: string, at: string): Promise<string> {
  const named = within(root, path.resolve(root, at));
  if (named === undefined) throw outside();
  if (isSecretPath(named)) throw refused();
  let real: string;
  try {
    real = await realpath(path.resolve(root, at));
  } catch (error: unknown) {
    throw new HostProtocolError('not_found', 'Nothing is at this path in the Host workspace.', { reason: 'path_not_found', cause: error });
  }
  // A link inside the workspace may lead out of it, or to a secret under another name.
  const reached = within(root, real);
  if (reached === undefined) throw outside();
  if (isSecretPath(reached)) throw refused();
  return real;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

async function describeEntry(directory: string, entry: Dirent): Promise<WorkspaceEntry | undefined> {
  if (entry.isSymbolicLink()) return { name: entry.name, kind: 'link' };
  let facts;
  try {
    facts = await lstat(path.join(directory, entry.name));
  } catch (error: unknown) {
    // Removed since the directory was read: it is no longer there to show.
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  const modifiedAt = Math.floor(facts.mtimeMs);
  if (facts.isDirectory()) return { name: entry.name, kind: 'directory', modifiedAt };
  if (facts.isFile()) return { name: entry.name, kind: 'file', size: facts.size, modifiedAt };
  return { name: entry.name, kind: 'other', modifiedAt };
}

/** A page of what a directory holds, by name. `cursor` is the last name of the page before. */
export async function listWorkspace(
  root: string, at: string, options: { readonly limit?: number; readonly cursor?: string } = {},
): Promise<{ entries: readonly WorkspaceEntry[]; nextCursor?: string }> {
  const directory = await resolveInside(root, at);
  let found: Dirent[];
  try {
    found = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOTDIR') throw error;
    throw new HostProtocolError('invalid_params', 'The path names a file, not a directory.', { reason: 'not_a_directory', cause: error });
  }
  const { limit = LIST_PAGE, cursor } = options;
  const shown = found
    .filter(entry => !isSecretPath(entry.name) && (cursor === undefined || entry.name > cursor))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const page = shown.slice(0, limit);
  const entries = (await Promise.all(page.map(entry => describeEntry(directory, entry))))
    .filter((entry): entry is WorkspaceEntry => entry !== undefined);
  return { entries, nextCursor: shown.length > limit ? page.at(-1)?.name : undefined };
}

function readCursor(cursor: string): { offset: number; version: string } {
  const match = /^(\d+)\.(.+)$/.exec(cursor);
  if (match === null) throw new HostProtocolError('invalid_params', 'cursor is not one this method gave.', { reason: 'cursor_invalid' });
  return { offset: Number(match[1]), version: match[2]! };
}

/**
 * A chunk of a file. Every chunk says the whole file's length. A cursor whose
 * file changed since fails with `resync_required`, and the client reads again
 * from the start.
 */
export async function readWorkspaceFile(
  root: string, at: string, cursor?: string,
): Promise<{ data: string; byteLength: number; modifiedAt: number; nextCursor?: string }> {
  const from = cursor === undefined ? undefined : readCursor(cursor);
  const file = await resolveInside(root, at);
  const handle = await open(file, 'r').catch((error: unknown) => {
    if (errorCode(error) !== 'EISDIR') throw error;
    throw new HostProtocolError('invalid_params', 'The path names a directory, not a file.', { reason: 'not_a_file', cause: error });
  });
  try {
    const opened = await handle.stat({ bigint: true });
    // A part of the path may have become a link between the check and the open: what was opened must be what was checked.
    const named = await stat(await realpath(file), { bigint: true });
    if (named.ino !== opened.ino || named.dev !== opened.dev) throw outside();
    if (!opened.isFile()) throw new HostProtocolError('invalid_params', 'The path names a directory, not a file.', { reason: 'not_a_file' });
    const version = `${opened.ino}-${opened.mtimeNs}-${opened.size}`;
    if (from !== undefined && from.version !== version) {
      throw new HostProtocolError('resync_required', 'The file changed; read it again from the start.', { reason: 'file_changed' });
    }
    const byteLength = Number(opened.size);
    const offset = Math.min(from?.offset ?? 0, byteLength);
    const data = Buffer.alloc(Math.min(HOST_BLOB_LIMITS.blobChunkBytes, byteLength - offset));
    let filled = 0;
    while (filled < data.length) {
      const { bytesRead } = await handle.read(data, filled, data.length - filled, offset + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const next = offset + filled;
    return {
      data: data.subarray(0, filled).toString('base64'),
      byteLength,
      modifiedAt: Math.floor(Number(opened.mtimeMs)),
      nextCursor: next < byteLength ? `${next}.${version}` : undefined,
    };
  } finally {
    await handle.close();
  }
}

/** Pathspecs that keep files holding secrets out of a diff. */
const SECRET_PATHSPECS = [
  ...[...SECRET_DIRECTORIES].map(name => `:(exclude,icase,glob)**/${name}/**`),
  ...[...SECRET_FILES].map(name => `:(exclude,icase,glob)**/${name}`),
  ':(exclude,icase,glob)**/.env.*',
];

/**
 * What git sees changed under a directory: in the working tree, or `staged`.
 * Paths in the diff are relative to that directory. A diff longer than
 * `MAX_DIFF_BYTES` is cut at a line and says `truncated`.
 */
export async function workspaceGitDiff(
  root: string, at: string, staged: boolean,
): Promise<{ diff: string; truncated?: true }> {
  const directory = await resolveInside(root, at);
  if (!(await stat(directory)).isDirectory()) {
    throw new HostProtocolError('invalid_params', 'The path names a file, not a directory.', { reason: 'not_a_directory' });
  }
  await assertNoGitInstallPrompt({ cwd: directory });
  // Outside a repository git diff compares paths instead, so ask first.
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], directory);
  if (inside.code !== 0 || inside.stdout.toString('utf8').trim() !== 'true') {
    throw new HostProtocolError('invalid_state', 'The directory is not in a git work tree.', { reason: 'not_a_git_repository' });
  }
  await refuseRepositoryFilters(directory);
  const args = [
    // Reading must run nothing the repository configures.
    '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false',
    'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--relative', ...(staged ? ['--cached'] : []),
    '--', '.', ...SECRET_PATHSPECS,
  ];
  const { stdout, stderr, code, cut } = await runGit(args, directory);
  if (!cut && code !== 0) {
    throw new Error(`git diff failed with ${code}: ${stderr.trim()}`);
  }
  if (!cut) return { diff: stdout.toString('utf8') };
  const lineEnd = stdout.lastIndexOf(0x0a, MAX_DIFF_BYTES - 1);
  return { diff: stdout.subarray(0, lineEnd + 1).toString('utf8'), truncated: true };
}

/**
 * git runs a filter driver's command when it reads a changed file, and no
 * option turns that off. A filter the Host's own git config names is the
 * operator's choice, such as Git LFS. One the repository's config names may
 * have been written by whoever works in the workspace.
 */
async function refuseRepositoryFilters(directory: string): Promise<void> {
  const found = await runGit(['config', '--show-scope', '--get-regexp', '^filter\\.'], directory);
  // 1 means no filter is configured anywhere.
  if (found.code === 1) return;
  if (found.code !== 0) throw new Error(`git config failed with ${found.code}: ${found.stderr.trim()}`);
  if (/^(?:local|worktree)\s/m.test(found.stdout.toString('utf8'))) {
    throw new HostProtocolError('forbidden', "The repository's own config names a filter, which reading it would run.", {
      reason: 'repository_filters',
    });
  }
}

/** Runs git, keeping one byte past `MAX_DIFF_BYTES` of what it prints before stopping it. */
function runGit(args: readonly string[], cwd: string): Promise<{ stdout: Buffer; stderr: string; code: number | null; cut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
      // No index lock for a read, and never a prompt for credentials.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let cut = false;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (cut) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_DIFF_BYTES) {
        cut = true;
        child.kill();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (!cut) reject(error);
    });
    child.on('close', code => resolve({ stdout: Buffer.concat(chunks), stderr, code, cut }));
  });
}
